use anyhow::Context;
use async_stream::stream;
use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, post},
    Json, Router,
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
    sync::{broadcast, oneshot, Mutex},
    time::{timeout, Duration},
};
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::info;
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(name = "codex-warp-server")]
struct Args {
    /// Bind address (e.g. 0.0.0.0:8765)
    #[arg(long, default_value = "127.0.0.1:8765")]
    bind: String,

    /// Data directory for sessions/logs (default: ~/.codex-warp)
    #[arg(long)]
    data_dir: Option<String>,

    /// Path to codex executable (default: search PATH)
    #[arg(long)]
    codex_path: Option<String>,

    /// Codex home directory for reading native sessions (default: $CODEX_HOME or ~/.codex)
    #[arg(long)]
    codex_home: Option<String>,

    /// Path to the built web UI directory (Vite `dist/`). If present, the server will host it.
    #[arg(long)]
    web_dist: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SessionStatus {
    Running,
    Done,
    Error,
}

#[derive(Clone, Serialize, Deserialize)]
struct SessionMeta {
    id: String,
    title: String,
    created_at_ms: u64,
    #[serde(default)]
    last_used_at_ms: u64,
    cwd: Option<String>,
    status: SessionStatus,
    codex_session_id: Option<String>,
    #[serde(default)]
    context_window: Option<u64>,
    #[serde(default)]
    context_used_tokens: Option<u64>,
    #[serde(default)]
    context_left_pct: Option<u8>,
    events_path: String,
    stderr_path: String,
    conclusion_path: String,
}

#[derive(Clone, Serialize)]
struct UiEvent {
    session_id: String,
    ts_ms: u64,
    stream: String,
    raw: String,
    json: Option<serde_json::Value>,
}

#[derive(Clone, Serialize)]
struct RunFinished {
    session_id: String,
    ts_ms: u64,
    exit_code: Option<i32>,
    success: bool,
}

#[derive(Clone, Serialize)]
struct ContextMetrics {
    session_id: String,
    ts_ms: u64,
    context_left_pct: u8,
    context_used_tokens: u64,
    context_window: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct UsageRecord {
    ts_ms: u64,
    session_id: String,
    thread_id: Option<String>,
    total_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    cached_input_tokens: u64,
    context_window: u64,
}

#[derive(Clone, Serialize)]
struct SkillSummary {
    name: String,
    description: String,
    path: String,
}

struct RunHandle {
    cancel: Option<oneshot::Sender<()>>,
    pid: Option<u32>,
}

#[derive(Clone)]
struct SseMessage {
    event: &'static str,
    data: String,
}

#[derive(Clone)]
struct AppState {
    data_dir: PathBuf,
    codex_path: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    runs: Arc<Mutex<HashMap<String, RunHandle>>>,
    streams: Arc<Mutex<HashMap<String, broadcast::Sender<SseMessage>>>>,
    native_cache: Arc<Mutex<NativeCache>>,
}

#[derive(Clone)]
struct NativeCache {
    built_at_ms: u64,
    rollouts_by_session: HashMap<String, Vec<PathBuf>>,
    derived_by_session: HashMap<String, NativeDerived>,
}

#[derive(Clone)]
struct NativeDerived {
    latest_path: PathBuf,
    latest_mtime_ms: u64,
    cwd: Option<String>,
    originator: Option<String>,
    source: Option<String>,
    last_prompt: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn default_data_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let t = home.trim();
    if t.is_empty() {
        return None;
    }
    Some(PathBuf::from(t).join(".codex-warp"))
}

fn default_codex_home() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("CODEX_HOME") {
        let t = raw.trim();
        if !t.is_empty() {
            return Some(PathBuf::from(t));
        }
    }
    let home = std::env::var("HOME").ok()?;
    let t = home.trim();
    if t.is_empty() {
        return None;
    }
    Some(PathBuf::from(t).join(".codex"))
}

fn codex_skills_root() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("CODEX_HOME") {
        let t = raw.trim();
        if !t.is_empty() {
            return Some(PathBuf::from(t).join("skills"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let t = home.trim();
        if !t.is_empty() {
            return Some(PathBuf::from(t).join(".codex").join("skills"));
        }
    }
    None
}

fn unquote_yaml_scalar(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return String::new();
    }
    let bytes = t.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if first == b'"' && last == b'"' {
            let mut out = String::with_capacity(t.len());
            let mut chars = t[1..t.len() - 1].chars();
            while let Some(ch) = chars.next() {
                if ch != '\\' {
                    out.push(ch);
                    continue;
                }
                let Some(next) = chars.next() else {
                    break;
                };
                match next {
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    '\\' => out.push('\\'),
                    '"' => out.push('"'),
                    other => out.push(other),
                }
            }
            return out.trim().to_string();
        }
        if first == b'\'' && last == b'\'' {
            return t[1..t.len() - 1].trim().to_string();
        }
    }
    t.to_string()
}

fn parse_skill_front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    let Some(first) = lines.next() else {
        return (None, None);
    };
    if first.trim() != "---" {
        return (None, None);
    }

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;

    for line in lines {
        let t = line.trim();
        if t == "---" {
            break;
        }
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let Some((k, v)) = t.split_once(':') else {
            continue;
        };
        match k.trim() {
            "name" => {
                let val = unquote_yaml_scalar(v);
                if !val.is_empty() {
                    name = Some(val);
                }
            }
            "description" => {
                let val = unquote_yaml_scalar(v);
                if !val.is_empty() {
                    description = Some(val);
                }
            }
            _ => {}
        }
    }

    (name, description)
}

fn sessions_root(state: &AppState) -> PathBuf {
    state.data_dir.join("sessions")
}

fn session_dir(state: &AppState, session_id: &str) -> PathBuf {
    sessions_root(state).join(session_id)
}

fn meta_path(state: &AppState, session_id: &str) -> PathBuf {
    session_dir(state, session_id).join("meta.json")
}

fn safe_title(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return "New session".to_string();
    }
    let s = trimmed.replace('\n', " ");
    const MAX_CHARS: usize = 60;
    if s.chars().count() <= MAX_CHARS {
        return s;
    }
    let mut out: String = s.chars().take(MAX_CHARS).collect();
    out.push('…');
    out
}

async fn read_meta(path: &Path) -> Option<SessionMeta> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let mut meta: SessionMeta = serde_json::from_slice(&bytes).ok()?;
    if meta.last_used_at_ms == 0 {
        meta.last_used_at_ms = meta.created_at_ms;
    }
    Some(meta)
}

async fn write_meta(path: &Path, meta: &SessionMeta) -> anyhow::Result<()> {
    tokio::fs::write(path, serde_json::to_vec_pretty(meta).unwrap_or_default())
        .await
        .context("write meta.json")?;
    Ok(())
}

async fn ensure_stream(state: &AppState, session_id: &str) -> broadcast::Sender<SseMessage> {
    let mut locked = state.streams.lock().await;
    if let Some(tx) = locked.get(session_id) {
        return tx.clone();
    }
    let (tx, _rx) = broadcast::channel::<SseMessage>(4096);
    locked.insert(session_id.to_string(), tx.clone());
    tx
}

async fn broadcast_event(state: &AppState, session_id: &str, event: &'static str, data: String) {
    let tx = ensure_stream(state, session_id).await;
    let _ = tx.send(SseMessage { event, data });
}

async fn broadcast_ui_event(state: &AppState, payload: UiEvent) {
    if let Ok(data) = serde_json::to_string(&payload) {
        broadcast_event(state, &payload.session_id, "codex_event", data).await;
    }
}

async fn broadcast_run_finished(state: &AppState, payload: RunFinished) {
    if let Ok(data) = serde_json::to_string(&payload) {
        broadcast_event(state, &payload.session_id, "codex_run_finished", data).await;
    }
}

async fn broadcast_metrics(state: &AppState, payload: ContextMetrics) {
    if let Ok(data) = serde_json::to_string(&payload) {
        broadcast_event(state, &payload.session_id, "codex_metrics", data).await;
    }
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            return meta.permissions().mode() & 0o111 != 0;
        }
    }
    true
}

fn resolve_codex_executable(state: &AppState) -> anyhow::Result<PathBuf> {
    if let Some(p) = state.codex_path.clone() {
        if is_executable(&p) {
            return Ok(p);
        }
        anyhow::bail!("Configured codex_path is not executable: {}", p.display());
    }

    if let Some(path_env) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let cand = dir.join("codex");
            if is_executable(&cand) {
                return Ok(cand);
            }
        }
    }

    anyhow::bail!("codex executable not found on PATH (set --codex-path)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn extract_session_meta_triplet_falls_back_when_base_instructions_precedes_originator() {
        let mut path = std::env::temp_dir();
        path.push(format!("codex-warp-rollout-{}.jsonl", Uuid::new_v4()));

        let line = serde_json::json!({
            "timestamp": "2026-01-01T00:00:00.000Z",
            "type": "session_meta",
            "payload": {
                "cwd": "/tmp",
                "base_instructions": { "text": "x" },
                "originator": "codex_exec",
                "source": "exec"
            }
        })
        .to_string();

        tokio::fs::write(&path, format!("{line}\n")).await.unwrap();

        let (cwd, originator, source) = extract_session_meta_triplet_from_rollout(&path).await;
        assert_eq!(cwd.as_deref(), Some("/tmp"));
        assert_eq!(originator.as_deref(), Some("codex_exec"));
        assert_eq!(source.as_deref(), Some("exec"));

        let _ = tokio::fs::remove_file(&path).await;
    }
}

async fn read_tail_lines(path: &Path, max_lines: usize) -> Vec<String> {
    if max_lines == 0 {
        return Vec::new();
    }
    let file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let mut out: VecDeque<String> = VecDeque::new();
    let mut lines = BufReader::new(file).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        while out.len() >= max_lines {
            out.pop_front();
        }
        out.push_back(line);
    }
    out.into_iter().collect()
}

#[derive(Deserialize)]
struct CodexHistoryLine {
    session_id: String,
    ts: i64,
    text: String,
}

#[derive(Clone)]
struct CodexHistoryAgg {
    first_ts_ms: u64,
    last_ts_ms: u64,
    last_text: String,
}

fn parse_rollout_session_id(file_name: &str) -> Option<String> {
    if !file_name.starts_with("rollout-") || !file_name.ends_with(".jsonl") {
        return None;
    }
    let base = &file_name["rollout-".len()..file_name.len() - ".jsonl".len()];
    if base.len() <= 20 {
        return None;
    }
    // "YYYY-MM-DDTHH-MM-SS-<session_id>"
    if base.as_bytes().get(19) != Some(&b'-') {
        return None;
    }
    let id = base[20..].trim();
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

fn scan_codex_rollouts(root: &Path) -> HashMap<String, Vec<PathBuf>> {
    let mut out: HashMap<String, Vec<PathBuf>> = HashMap::new();

    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let ty = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let path = entry.path();
            if ty.is_dir() {
                stack.push(path);
                continue;
            }
            if !ty.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(session_id) = parse_rollout_session_id(&name) else {
                continue;
            };
            out.entry(session_id).or_default().push(path);
        }
    }

    for paths in out.values_mut() {
        paths.sort_by_key(|p| p.file_name().map(|s| s.to_string_lossy().to_string()));
    }

    out
}

async fn ensure_native_cache(state: &AppState) {
    let Some(codex_home) = state.codex_home.clone() else {
        return;
    };

    {
        let locked = state.native_cache.lock().await;
        if locked.built_at_ms > 0 && locked.built_at_ms.saturating_add(3_000) > now_ms() {
            return;
        }
    }

    let codex_home_for_scan = codex_home.clone();
    let scanned = tokio::task::spawn_blocking(move || {
        let mut merged: HashMap<String, Vec<PathBuf>> = HashMap::new();
        let sessions_dir = codex_home_for_scan.join("sessions");
        if sessions_dir.is_dir() {
            merged.extend(scan_codex_rollouts(&sessions_dir));
        }
        let archived_dir = codex_home_for_scan.join("archived_sessions");
        if archived_dir.is_dir() {
            for (k, v) in scan_codex_rollouts(&archived_dir) {
                merged.entry(k).or_default().extend(v);
            }
        }
        for paths in merged.values_mut() {
            paths.sort_by_key(|p| p.file_name().map(|s| s.to_string_lossy().to_string()));
        }
        merged
    })
    .await
    .unwrap_or_default();

    {
        let mut locked = state.native_cache.lock().await;
        locked.built_at_ms = now_ms();
        locked
            .derived_by_session
            .retain(|k, _| scanned.contains_key(k));
        locked.rollouts_by_session = scanned;
    }
}

async fn read_prefix(path: &Path, max_bytes: usize) -> anyhow::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await?;
    let mut buf = vec![0u8; max_bytes];
    let n = file.read(&mut buf).await?;
    buf.truncate(n);
    Ok(buf)
}

fn extract_json_string_field(prefix: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", key);
    let start = prefix.find(&needle)? + needle.len();
    let mut out = String::new();
    let mut chars = prefix[start..].chars();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            return Some(out);
        }
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        let Some(next) = chars.next() else {
            break;
        };
        match next {
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            '\\' => out.push('\\'),
            '"' => out.push('"'),
            'u' => {
                let mut hex = String::new();
                for _ in 0..4 {
                    let Some(h) = chars.next() else {
                        break;
                    };
                    hex.push(h);
                }
                if let Ok(code) = u32::from_str_radix(&hex, 16) {
                    if let Some(c) = char::from_u32(code) {
                        out.push(c);
                    }
                }
            }
            other => out.push(other),
        }
    }
    None
}

async fn extract_cwd_from_rollout(path: &Path) -> Option<String> {
    extract_session_meta_field_from_rollout(path, "cwd").await
}

async fn extract_session_meta_field_from_rollout(path: &Path, key: &str) -> Option<String> {
    let prefix = read_prefix(path, 16_384).await.ok()?;
    let text = String::from_utf8_lossy(&prefix);
    let clipped = match text.find("\"base_instructions\"") {
        Some(idx) => &text[..idx],
        None => &text,
    };
    extract_json_string_field(clipped, key)
}

async fn extract_session_meta_triplet_from_rollout(
    path: &Path,
) -> (Option<String>, Option<String>, Option<String>) {
    let cwd = extract_session_meta_field_from_rollout(path, "cwd").await;
    let originator = extract_session_meta_field_from_rollout(path, "originator").await;
    let source = extract_session_meta_field_from_rollout(path, "source").await;

    // Fast path: most rollouts have originator at the beginning of the meta line.
    if originator.is_some() {
        return (cwd, originator, source);
    }

    // Slow path: handle cases where the session_meta line puts huge fields (like base_instructions)
    // before originator/source, making prefix-scanning unreliable.
    #[derive(Deserialize)]
    struct RolloutMetaLine {
        #[serde(rename = "type")]
        ty: Option<String>,
        payload: Option<RolloutMetaPayload>,
    }
    #[derive(Deserialize)]
    struct RolloutMetaPayload {
        cwd: Option<String>,
        originator: Option<String>,
        source: Option<String>,
    }

    let path_for_parse = path.to_path_buf();
    let parsed = tokio::task::spawn_blocking(
        move || -> Option<(Option<String>, Option<String>, Option<String>)> {
            let file = std::fs::File::open(path_for_parse).ok()?;
            let mut de = serde_json::Deserializer::from_reader(file);
            let meta = RolloutMetaLine::deserialize(&mut de).ok()?;
            if meta.ty.as_deref() != Some("session_meta") {
                return None;
            }
            let payload = meta.payload?;
            Some((payload.cwd, payload.originator, payload.source))
        },
    )
    .await
    .ok()
    .flatten();

    if let Some((cwd2, originator2, source2)) = parsed {
        return (cwd.or(cwd2), originator.or(originator2), source.or(source2));
    }

    (cwd, originator, source)
}

async fn file_mtime_ms(path: &Path) -> Option<u64> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    let m = meta.modified().ok()?;
    let dur = m.duration_since(UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as u64)
}

fn load_codex_history(codex_home: &Path) -> HashMap<String, CodexHistoryAgg> {
    use std::io::BufRead;

    let mut out: HashMap<String, CodexHistoryAgg> = HashMap::new();
    let path = codex_home.join("history.jsonl");
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return out,
    };
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().flatten() {
        let rec: CodexHistoryLine = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rec.session_id.trim().is_empty() {
            continue;
        }
        let ts_ms = rec.ts.max(0) as u64 * 1000;
        out.entry(rec.session_id.clone())
            .and_modify(|a| {
                a.first_ts_ms = a.first_ts_ms.min(ts_ms);
                if ts_ms >= a.last_ts_ms {
                    a.last_ts_ms = ts_ms;
                    a.last_text = rec.text.clone();
                }
            })
            .or_insert_with(|| CodexHistoryAgg {
                first_ts_ms: ts_ms,
                last_ts_ms: ts_ms,
                last_text: rec.text.clone(),
            });
    }
    out
}

fn load_codex_thread_titles(codex_home: &Path) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let path = codex_home.join(".codex-global-state.json");
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return out,
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return out,
    };
    let Some(obj) = value
        .get("thread-titles")
        .and_then(|v| v.get("titles"))
        .and_then(|v| v.as_object())
    else {
        return out;
    };
    for (k, v) in obj {
        let Some(title) = v.as_str() else {
            continue;
        };
        if !k.trim().is_empty() && !title.trim().is_empty() {
            out.insert(k.clone(), title.trim().to_string());
        }
    }
    out
}

fn should_show_rollout_user_text(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    if t.starts_with("# AGENTS.md") {
        return false;
    }
    if t.starts_with("<environment_context") {
        return false;
    }
    if t.contains("<INSTRUCTIONS>") {
        return false;
    }
    true
}

fn extract_rollout_content_text(content: &serde_json::Value) -> String {
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let ty = obj.get("type").and_then(|v| v.as_str()).unwrap_or_default();
        if ty != "input_text" && ty != "output_text" {
            continue;
        }
        let Some(text) = obj.get("text").and_then(|v| v.as_str()) else {
            continue;
        };
        out.push_str(text);
    }
    out
}

async fn read_tail_bytes(path: &Path, max_bytes: u64) -> Vec<String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let len = match file.metadata().await {
        Ok(m) => m.len(),
        Err(_) => return Vec::new(),
    };
    let start = len.saturating_sub(max_bytes);
    if start > 0 {
        let _ = file.seek(std::io::SeekFrom::Start(start)).await;
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).await.is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut iter = text.lines();
    if start > 0 {
        // Drop potential partial line due to seeking into the middle.
        let _ = iter.next();
    }
    iter.map(|l| l.to_string()).collect()
}

async fn find_last_prompt_from_rollout(path: &Path) -> Option<String> {
    const MAX_BYTES: u64 = 96 * 1024;
    let lines = read_tail_bytes(path, MAX_BYTES).await;
    for raw in lines.into_iter().rev() {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(t).ok()?;
        let Some(kind) = v.get("type").and_then(|x| x.as_str()) else {
            continue;
        };

        if kind == "event_msg" {
            let Some(payload) = v.get("payload").and_then(|x| x.as_object()) else {
                continue;
            };
            if payload.get("type").and_then(|x| x.as_str()) != Some("user_message") {
                continue;
            }
            let Some(message) = payload.get("message").and_then(|x| x.as_str()) else {
                continue;
            };
            if should_show_rollout_user_text(message) {
                return Some(message.trim().to_string());
            }
            continue;
        }

        if kind == "response_item" {
            let Some(payload) = v.get("payload").and_then(|x| x.as_object()) else {
                continue;
            };
            if payload.get("type").and_then(|x| x.as_str()) != Some("message") {
                continue;
            }
            if payload.get("role").and_then(|x| x.as_str()) != Some("user") {
                continue;
            }
            let content = payload.get("content")?;
            let text = extract_rollout_content_text(content);
            if should_show_rollout_user_text(&text) {
                return Some(text.trim().to_string());
            }
            continue;
        }
    }
    None
}

async fn get_or_compute_native_derived(
    state: &AppState,
    session_id: &str,
    latest_path: &Path,
) -> NativeDerived {
    let latest_mtime_ms = file_mtime_ms(latest_path).await.unwrap_or(0);
    {
        let locked = state.native_cache.lock().await;
        if let Some(cached) = locked.derived_by_session.get(session_id) {
            if cached.latest_path == latest_path && cached.latest_mtime_ms == latest_mtime_ms {
                return cached.clone();
            }
        }
    }

    let (cwd, originator, source) = extract_session_meta_triplet_from_rollout(latest_path).await;
    let last_prompt = find_last_prompt_from_rollout(latest_path).await;

    let derived = NativeDerived {
        latest_path: latest_path.to_path_buf(),
        latest_mtime_ms,
        cwd,
        originator,
        source,
        last_prompt,
    };

    let mut locked = state.native_cache.lock().await;
    locked
        .derived_by_session
        .insert(session_id.to_string(), derived.clone());
    derived
}

async fn native_session_meta(state: &AppState, session_id: &str) -> Option<SessionMeta> {
    let codex_home = state.codex_home.clone()?;
    ensure_native_cache(state).await;

    let paths = {
        let locked = state.native_cache.lock().await;
        locked.rollouts_by_session.get(session_id).cloned()
    };
    let paths = paths?;
    if paths.is_empty() {
        return None;
    }
    let earliest_path = paths.first().cloned().unwrap_or_else(|| PathBuf::from(""));
    let latest_path = paths.last().cloned().unwrap_or_else(|| PathBuf::from(""));

    let derived = get_or_compute_native_derived(state, session_id, &latest_path).await;
    if derived.source.as_deref() == Some("exec") || derived.originator.as_deref() == Some("codex_exec") {
        return None;
    }
    let cwd = derived.cwd.clone();

    let session_id_owned = session_id.to_string();
    let titles = tokio::task::spawn_blocking(move || load_codex_thread_titles(&codex_home))
    .await
    .unwrap_or_default();

    let created_at_ms = file_mtime_ms(&earliest_path).await.unwrap_or_else(now_ms);
    let last_used_at_ms = file_mtime_ms(&latest_path).await.unwrap_or_else(now_ms);

    let title = titles.get(&session_id_owned).cloned().or_else(|| {
        derived
            .last_prompt
            .as_deref()
            .filter(|t| should_show_rollout_user_text(t))
            .map(safe_title)
    })?;

    Some(SessionMeta {
        id: session_id_owned.clone(),
        title,
        created_at_ms,
        last_used_at_ms,
        cwd,
        status: SessionStatus::Done,
        codex_session_id: Some(session_id_owned),
        context_window: None,
        context_used_tokens: None,
        context_left_pct: None,
        events_path: latest_path.to_string_lossy().to_string(),
        stderr_path: String::new(),
        conclusion_path: String::new(),
    })
}

async fn list_sessions(State(state): State<AppState>) -> Result<Json<Vec<SessionMeta>>, StatusCode> {
    let mut merged: HashMap<String, SessionMeta> = HashMap::new();

    let root = sessions_root(&state);
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut rd = tokio::fs::read_dir(&root)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    while let Ok(Some(entry)) = rd.next_entry().await {
        let ty = entry.file_type().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if !ty.is_dir() {
            continue;
        }
        let mp = entry.path().join("meta.json");
        if let Some(meta) = read_meta(&mp).await {
            merged.insert(meta.id.clone(), meta);
        }
    }

    if let Some(codex_home) = state.codex_home.clone() {
        ensure_native_cache(&state).await;
        let rollouts = {
            let locked = state.native_cache.lock().await;
            locked.rollouts_by_session.clone()
        };
        let titles = tokio::task::spawn_blocking(move || load_codex_thread_titles(&codex_home))
        .await
        .unwrap_or_default();

        for (session_id, paths) in rollouts {
            if paths.is_empty() {
                continue;
            }
            let earliest_path = paths
                .first()
                .cloned()
                .unwrap_or_else(|| PathBuf::from(""));
            let latest_path = paths
                .last()
                .cloned()
                .unwrap_or_else(|| PathBuf::from(""));

            let derived = get_or_compute_native_derived(&state, &session_id, &latest_path).await;
            if derived.source.as_deref() == Some("exec")
                || derived.originator.as_deref() == Some("codex_exec")
            {
                continue;
            }
            let cwd = derived.cwd.clone();

            let created_at_ms = file_mtime_ms(&earliest_path).await.unwrap_or_else(now_ms);
            let last_used_at_ms = if derived.latest_mtime_ms > 0 {
                derived.latest_mtime_ms
            } else {
                file_mtime_ms(&latest_path).await.unwrap_or_else(now_ms)
            };

            let title = titles.get(&session_id).cloned().or_else(|| {
                derived
                    .last_prompt
                    .as_deref()
                    .filter(|t| should_show_rollout_user_text(t))
                    .map(safe_title)
            });
            let Some(title) = title else {
                // Hide sessions with no meaningful user prompt to keep the list close to the official app.
                continue;
            };

            let native = SessionMeta {
                id: session_id.clone(),
                title,
                created_at_ms,
                last_used_at_ms,
                cwd,
                status: SessionStatus::Done,
                codex_session_id: Some(session_id.clone()),
                context_window: None,
                context_used_tokens: None,
                context_left_pct: None,
                events_path: latest_path.to_string_lossy().to_string(),
                stderr_path: String::new(),
                conclusion_path: String::new(),
            };

            merged
                .entry(session_id.clone())
                .and_modify(|s| {
                    if s.cwd.is_none() {
                        s.cwd = native.cwd.clone();
                    }
                    if native.created_at_ms < s.created_at_ms {
                        s.created_at_ms = native.created_at_ms;
                    }
                    s.last_used_at_ms = s.last_used_at_ms.max(native.last_used_at_ms);
                })
                .or_insert(native);
        }
    }

    let mut sessions: Vec<SessionMeta> = merged.into_values().collect();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.last_used_at_ms.max(s.created_at_ms)));
    Ok(Json(sessions))
}

#[derive(Deserialize)]
struct StartRequest {
    prompt: String,
    cwd: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

async fn start_session(
    State(state): State<AppState>,
    Json(req): Json<StartRequest>,
) -> Result<Json<SessionMeta>, Response> {
    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "prompt is required").into_response());
    }

    let session_id = match req.session_id {
        Some(raw) => Uuid::parse_str(raw.trim())
            .map_err(|_| (StatusCode::BAD_REQUEST, "invalid session_id").into_response())?
            .to_string(),
        None => Uuid::new_v4().to_string(),
    };

    let dir = session_dir(&state, &session_id);
    if tokio::fs::metadata(&dir).await.is_ok() {
        return Err((StatusCode::CONFLICT, "session already exists").into_response());
    }
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;

    let created_at_ms = now_ms();
    let last_used_at_ms = created_at_ms;

    let events_path = dir.join("events.jsonl");
    let stderr_path = dir.join("stderr.log");
    let conclusion_path = dir.join("conclusion.md");

    let cwd = req.cwd.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

    let meta = SessionMeta {
        id: session_id.clone(),
        title: safe_title(&prompt),
        created_at_ms,
        last_used_at_ms,
        cwd: cwd.clone(),
        status: SessionStatus::Running,
        codex_session_id: None,
        context_window: None,
        context_used_tokens: None,
        context_left_pct: None,
        events_path: events_path.to_string_lossy().to_string(),
        stderr_path: stderr_path.to_string_lossy().to_string(),
        conclusion_path: conclusion_path.to_string_lossy().to_string(),
    };

    write_meta(&dir.join("meta.json"), &meta)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;

    {
        use tokio::io::AsyncWriteExt;
        let ts = now_ms();
        let prompt_event = serde_json::json!({
            "type": "app.prompt",
            "prompt": prompt.clone(),
            "_ts_ms": ts,
        });
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&events_path)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
        file.write_all(prompt_event.to_string().as_bytes())
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
        file.write_all(b"\n")
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;

        broadcast_ui_event(
            &state,
            UiEvent {
                session_id: session_id.clone(),
                ts_ms: ts,
                stream: "stdout".to_string(),
                raw: prompt_event.to_string(),
                json: Some(prompt_event),
            },
        )
        .await;
    }

    let codex = resolve_codex_executable(&state)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;

    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut runs = state.runs.lock().await;
        runs.insert(
            session_id.clone(),
            RunHandle {
                cancel: Some(cancel_tx),
                pid: None,
            },
        );
    }

    let state_for_run = state.clone();
    let session_id_for_run = session_id.clone();
    let events_path_for_run = events_path.clone();
    let stderr_path_for_run = stderr_path.clone();
    let conclusion_path_for_run = conclusion_path.clone();
    let meta_path_for_run = dir.join("meta.json");
    tokio::spawn(async move {
        run_turn_via_app_server(
            state_for_run,
            session_id_for_run,
            codex,
            cwd,
            None,
            prompt,
            events_path_for_run,
            stderr_path_for_run,
            conclusion_path_for_run,
            meta_path_for_run,
            cancel_rx,
        )
        .await;
    });

    Ok(Json(meta))
}

#[derive(Deserialize)]
struct ContinueRequest {
    prompt: String,
    cwd: Option<String>,
}

async fn continue_session(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Json(req): Json<ContinueRequest>,
) -> Result<Json<SessionMeta>, Response> {
    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "prompt is required").into_response());
    }

    {
        let runs = state.runs.lock().await;
        if runs.contains_key(&session_id) {
            return Err((StatusCode::CONFLICT, "session is already running").into_response());
        }
    }

    let cwd = req.cwd.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

    let dir = session_dir(&state, &session_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
    let meta_path = dir.join("meta.json");
    let mut meta = if let Some(meta) = read_meta(&meta_path).await {
        meta
    } else {
        let Some(native) = native_session_meta(&state, &session_id).await else {
            return Err((StatusCode::NOT_FOUND, "session not found").into_response());
        };
        let now = now_ms();
        let events_path = dir.join("events.jsonl");
        let stderr_path = dir.join("stderr.log");
        let conclusion_path = dir.join("conclusion.md");
        let created_at_ms = native.created_at_ms;
        let last_used_at_ms = now;

        let meta = SessionMeta {
            id: session_id.clone(),
            title: native.title,
            created_at_ms,
            last_used_at_ms,
            cwd: cwd.clone().or(native.cwd),
            status: SessionStatus::Done,
            codex_session_id: Some(session_id.clone()),
            context_window: None,
            context_used_tokens: None,
            context_left_pct: None,
            events_path: events_path.to_string_lossy().to_string(),
            stderr_path: stderr_path.to_string_lossy().to_string(),
            conclusion_path: conclusion_path.to_string_lossy().to_string(),
        };
        write_meta(&meta_path, &meta)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
        meta
    };

    let events_path = dir.join("events.jsonl");
    let stderr_path = dir.join("stderr.log");
    let conclusion_path = dir.join("conclusion.md");

    meta.status = SessionStatus::Running;
    meta.cwd = cwd.clone().or(meta.cwd);
    meta.last_used_at_ms = now_ms();
    meta.events_path = events_path.to_string_lossy().to_string();
    meta.stderr_path = stderr_path.to_string_lossy().to_string();
    meta.conclusion_path = conclusion_path.to_string_lossy().to_string();

    write_meta(&meta_path, &meta)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;

    {
        use tokio::io::AsyncWriteExt;
        let ts = now_ms();
        let prompt_event = serde_json::json!({
            "type": "app.prompt",
            "prompt": prompt.clone(),
            "_ts_ms": ts,
        });
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&events_path)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
        file.write_all(prompt_event.to_string().as_bytes())
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
        file.write_all(b"\n")
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
        broadcast_ui_event(
            &state,
            UiEvent {
                session_id: session_id.clone(),
                ts_ms: ts,
                stream: "stdout".to_string(),
                raw: prompt_event.to_string(),
                json: Some(prompt_event),
            },
        )
        .await;
    }

    let codex = resolve_codex_executable(&state)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;

    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut runs = state.runs.lock().await;
        runs.insert(
            session_id.clone(),
            RunHandle {
                cancel: Some(cancel_tx),
                pid: None,
            },
        );
    }

    let state_for_run = state.clone();
    let session_id_for_run = session_id.clone();
    let cwd_for_run = cwd.clone().or(meta.cwd.clone());
    let thread_id_for_run = meta.codex_session_id.clone();
    let events_path_for_run = events_path.clone();
    let stderr_path_for_run = stderr_path.clone();
    let conclusion_path_for_run = conclusion_path.clone();
    tokio::spawn(async move {
        run_turn_via_app_server(
            state_for_run,
            session_id_for_run,
            codex,
            cwd_for_run,
            thread_id_for_run,
            prompt,
            events_path_for_run,
            stderr_path_for_run,
            conclusion_path_for_run,
            meta_path,
            cancel_rx,
        )
        .await;
    });

    Ok(Json(meta))
}

async fn stop_session(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<StatusCode, Response> {
    let (cancel, pid) = {
        let mut runs = state.runs.lock().await;
        let Some(handle) = runs.get_mut(&session_id) else {
            return Ok(StatusCode::NO_CONTENT);
        };
        (handle.cancel.take(), handle.pid)
    };

    let mut receiver_dropped = false;
    if let Some(cancel) = cancel {
        if cancel.send(()).is_err() {
            receiver_dropped = true;
        }
    }

    if let Some(pid) = pid {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGINT);
        }
        #[cfg(unix)]
        {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(800)).await;
                unsafe {
                    // If the PID is still alive, force-kill it.
                    if libc::kill(pid as i32, 0) == 0 {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
            });
        }
    }

    if receiver_dropped {
        {
            let mut runs = state.runs.lock().await;
            runs.remove(&session_id);
        }
        if let Some(mut meta) = read_meta(&meta_path(&state, &session_id)).await {
            meta.status = SessionStatus::Error;
            let _ = write_meta(&meta_path(&state, &session_id), &meta).await;
        }
        broadcast_run_finished(
            &state,
            RunFinished {
                session_id,
                ts_ms: now_ms(),
                exit_code: None,
                success: false,
            },
        )
        .await;
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_session(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<StatusCode, Response> {
    let _ = stop_session(State(state.clone()), AxumPath(session_id.clone())).await;
    let dir = session_dir(&state, &session_id);
    let warp_exists = tokio::fs::metadata(&dir).await.ok().is_some_and(|m| m.is_dir());
    if warp_exists {
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
    }

    ensure_native_cache(&state).await;
    let native_paths = {
        let locked = state.native_cache.lock().await;
        locked.rollouts_by_session.get(&session_id).cloned()
    };
    let has_native = native_paths.is_some();
    if let Some(paths) = native_paths {
        for p in paths {
            let _ = tokio::fs::remove_file(p).await;
        }
    }

    if !warp_exists && !has_native {
        return Err((StatusCode::NOT_FOUND, "session not found").into_response());
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn rename_session(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Json(payload): Json<HashMap<String, String>>,
) -> Result<StatusCode, Response> {
    let Some(title) = payload.get("title") else {
        return Err((StatusCode::BAD_REQUEST, "title required").into_response());
    };
    let mp = meta_path(&state, &session_id);
    if let Some(mut meta) = read_meta(&mp).await {
        meta.title = title.clone();
        write_meta(&mp, &meta)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
        return Ok(StatusCode::NO_CONTENT);
    }

    ensure_native_cache(&state).await;
    let has_native = {
        let locked = state.native_cache.lock().await;
        locked.rollouts_by_session.contains_key(&session_id)
    };
    if !has_native {
        return Err((StatusCode::NOT_FOUND, "session not found").into_response());
    }

    let Some(codex_home) = state.codex_home.clone() else {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, "codex_home not configured").into_response());
    };
    let session_id_for_write = session_id.clone();
    let title_for_write = title.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let path = codex_home.join(".codex-global-state.json");
        let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        };
        if !root.is_object() {
            root = serde_json::json!({});
        }
        if !root.get("thread-titles").is_some_and(|v| v.is_object()) {
            root["thread-titles"] = serde_json::json!({});
        }
        if !root["thread-titles"]
            .get("titles")
            .is_some_and(|v| v.is_object())
        {
            root["thread-titles"]["titles"] = serde_json::json!({});
        }
        root["thread-titles"]["titles"][&session_id_for_write] =
            serde_json::Value::String(title_for_write.clone());

        if !root["thread-titles"]
            .get("order")
            .is_some_and(|v| v.is_array())
        {
            root["thread-titles"]["order"] = serde_json::json!([]);
        }
        if let Some(arr) = root["thread-titles"]["order"].as_array_mut() {
            let exists = arr.iter().any(|v| v.as_str() == Some(&session_id_for_write));
            if !exists {
                arr.insert(0, serde_json::Value::String(session_id_for_write.clone()));
            }
        }

        std::fs::write(&path, serde_json::to_vec_pretty(&root)?)?;
        Ok(())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
    Ok(StatusCode::NO_CONTENT)
}

async fn read_conclusion(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<String, Response> {
    let dir = session_dir(&state, &session_id);
    let path = dir.join("conclusion.md");
    if let Ok(text) = tokio::fs::read_to_string(&path).await {
        return Ok(text);
    }

    ensure_native_cache(&state).await;
    let has_native = {
        let locked = state.native_cache.lock().await;
        locked.rollouts_by_session.contains_key(&session_id)
    };
    if has_native {
        return Ok(String::new());
    }

    Err((StatusCode::NOT_FOUND, "session not found").into_response())
}

#[derive(Deserialize)]
struct UsageQuery {
    #[serde(default)]
    max_records: Option<usize>,
}

async fn list_usage_records(
    State(state): State<AppState>,
    Query(q): Query<UsageQuery>,
) -> Result<Json<Vec<UsageRecord>>, StatusCode> {
    let file = match tokio::fs::File::open(state.data_dir.join("usage.jsonl")).await {
        Ok(f) => f,
        Err(_) => return Ok(Json(Vec::new())),
    };
    let max_records = q.max_records.unwrap_or(5000).clamp(1, 200_000);

    let mut out: VecDeque<UsageRecord> = VecDeque::new();
    let mut lines = BufReader::new(file).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let record = match serde_json::from_str::<UsageRecord>(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        while out.len() >= max_records {
            out.pop_front();
        }
        out.push_back(record);
    }
    Ok(Json(out.into_iter().collect()))
}

async fn list_skills() -> Result<Json<Vec<SkillSummary>>, StatusCode> {
    let Some(root) = codex_skills_root() else {
        return Ok(Json(Vec::new()));
    };
    if tokio::fs::metadata(&root).await.is_err() {
        return Ok(Json(Vec::new()));
    }

    let mut stack: Vec<PathBuf> = vec![root];
    let mut out: Vec<SkillSummary> = Vec::new();

    while let Some(dir) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let ty = match entry.file_type().await {
                Ok(t) => t,
                Err(_) => continue,
            };
            let path = entry.path();
            if ty.is_dir() {
                stack.push(path);
                continue;
            }
            if !ty.is_file() {
                continue;
            }
            if entry.file_name().to_string_lossy() != "SKILL.md" {
                continue;
            }

            let text = match tokio::fs::read_to_string(&path).await {
                Ok(t) => t,
                Err(_) => continue,
            };
            let (name, description) = parse_skill_front_matter(&text);
            let name = name.or_else(|| {
                path.parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
            });
            let Some(name) = name else {
                continue;
            };
            out.push(SkillSummary {
                name,
                description: description.unwrap_or_default(),
                path: path.to_string_lossy().to_string(),
            });
        }
    }

    let mut dedup: HashMap<String, SkillSummary> = HashMap::new();
    for s in out {
        dedup.entry(s.name.clone()).or_insert(s);
    }
    let mut skills = dedup.into_values().collect::<Vec<_>>();
    skills.sort_by_key(|s| s.name.to_ascii_lowercase());
    Ok(Json(skills))
}

async fn touch_session(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Json<SessionMeta>, Response> {
    let mp = meta_path(&state, &session_id);
    if let Some(mut meta) = read_meta(&mp).await {
        meta.last_used_at_ms = now_ms();
        write_meta(&mp, &meta)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
        return Ok(Json(meta));
    }

    let Some(mut meta) = native_session_meta(&state, &session_id).await else {
        return Err((StatusCode::NOT_FOUND, "session not found").into_response());
    };
    meta.last_used_at_ms = now_ms();
    Ok(Json(meta))
}

#[derive(Deserialize)]
struct StreamQuery {
    #[serde(default)]
    tail: Option<usize>,
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    // https://howardhinnant.github.io/date_algorithms.html#days_from_civil
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_rfc3339_ms(ts: &str) -> Option<u64> {
    // Handles examples like: "2026-01-31T09:11:23.415Z"
    let s = ts.trim();
    if !s.ends_with('Z') {
        return None;
    }
    let s = &s[..s.len() - 1];
    let (date, time) = s.split_once('T')?;
    let mut date_it = date.split('-');
    let y: i64 = date_it.next()?.parse().ok()?;
    let m: i64 = date_it.next()?.parse().ok()?;
    let d: i64 = date_it.next()?.parse().ok()?;

    let mut time_it = time.split(':');
    let hh: i64 = time_it.next()?.parse().ok()?;
    let mm: i64 = time_it.next()?.parse().ok()?;
    let sec_part = time_it.next()?;
    let (ss_str, frac_str) = sec_part.split_once('.').unwrap_or((sec_part, ""));
    let ss: i64 = ss_str.parse().ok()?;
    let mut ms: i64 = 0;
    if !frac_str.is_empty() {
        let mut digits = frac_str.chars().take(3).collect::<String>();
        while digits.len() < 3 {
            digits.push('0');
        }
        ms = digits.parse::<i64>().ok()?;
    }

    let days = days_from_civil(y, m, d);
    let total_ms = days
        .checked_mul(86_400_000)?
        .checked_add(hh.checked_mul(3_600_000)?)?
        .checked_add(mm.checked_mul(60_000)?)?
        .checked_add(ss.checked_mul(1_000)?)?
        .checked_add(ms)?;
    if total_ms < 0 {
        return None;
    }
    Some(total_ms as u64)
}

async fn stream_session(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
    Query(q): Query<StreamQuery>,
    _headers: HeaderMap,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, std::convert::Infallible>>>, Response>
{
    let dir = session_dir(&state, &session_id);
    let warp_exists = tokio::fs::metadata(&dir).await.ok().is_some_and(|m| m.is_dir());
    let native_paths = {
        ensure_native_cache(&state).await;
        let locked = state.native_cache.lock().await;
        locked.rollouts_by_session.get(&session_id).cloned()
    };
    if !warp_exists && native_paths.is_none() {
        return Err((StatusCode::NOT_FOUND, "session not found").into_response());
    }

    let tail = match q.tail {
        Some(0) => 0,
        Some(n) => n.clamp(50, 50_000),
        None => 4000,
    };
    let events_path = dir.join("events.jsonl");
    let stderr_path = dir.join("stderr.log");

    let mut backlog: Vec<(u64, usize, UiEvent)> = Vec::new();
    let mut seq: usize = 0;

    if tail > 0 {
        if let Some(paths) = native_paths.clone() {
            for path in paths {
                for raw in read_tail_lines(&path, tail).await {
                    let mut json: Option<serde_json::Value> = None;
                    let mut ts_ms = now_ms();
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                        if let Some(t) = v
                            .get("timestamp")
                            .and_then(|x| x.as_str())
                            .and_then(parse_rfc3339_ms)
                        {
                            ts_ms = t;
                        }
                        json = Some(v);
                    }
                    backlog.push((
                        ts_ms,
                        seq,
                        UiEvent {
                            session_id: session_id.clone(),
                            ts_ms,
                            stream: "stdout".to_string(),
                            raw,
                            json,
                        },
                    ));
                    seq = seq.saturating_add(1);
                }
            }
        }

        if warp_exists {
            // Replay stdout events
            for raw in read_tail_lines(&events_path, tail).await {
                let mut json: Option<serde_json::Value> = None;
                let mut ts_ms = now_ms();
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(t) = v.get("_ts_ms").and_then(|x| x.as_u64()) {
                        ts_ms = t;
                    }
                    json = Some(v);
                }
                backlog.push((
                    ts_ms,
                    seq,
                    UiEvent {
                        session_id: session_id.clone(),
                        ts_ms,
                        stream: "stdout".to_string(),
                        raw,
                        json,
                    },
                ));
                seq = seq.saturating_add(1);
            }

            // Replay stderr as raw lines (timestamps may be embedded in text).
            for raw in read_tail_lines(&stderr_path, tail).await {
                backlog.push((
                    now_ms(),
                    seq,
                    UiEvent {
                        session_id: session_id.clone(),
                        ts_ms: now_ms(),
                        stream: "stderr".to_string(),
                        raw,
                        json: None,
                    },
                ));
                seq = seq.saturating_add(1);
            }
        }
    }

    backlog.sort_by_key(|(ts, seq, _)| (*ts, *seq));
    let mut backlog: Vec<UiEvent> = backlog.into_iter().map(|(_, _, e)| e).collect();
    if tail > 0 && backlog.len() > tail {
        backlog = backlog.split_off(backlog.len() - tail);
    }

    let tx = ensure_stream(&state, &session_id).await;
    let rx = tx.subscribe();

    let stream = stream! {
        for evt in backlog {
            if let Ok(data) = serde_json::to_string(&evt) {
                yield Ok(Event::default().event("codex_event").data(data));
            }
        }

        let mut live = BroadcastStream::new(rx);
        while let Some(item) = live.next().await {
            let Ok(msg) = item else { continue };
            yield Ok(Event::default().event(msg.event).data(msg.data));
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("keepalive")))
}

async fn healthz() -> &'static str {
    "ok"
}

// --- Codex app-server runner (adapted from the desktop app) ---

async fn write_jsonrpc_request(
    stdin: &mut ChildStdin,
    id: i64,
    method: &str,
    params: serde_json::Value,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let msg = serde_json::json!({ "id": id, "method": method, "params": params });
    let line = msg.to_string();
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    Ok(())
}

async fn read_next_json_line(
    lines: &mut tokio::io::Lines<BufReader<ChildStdout>>,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> anyhow::Result<Option<(String, serde_json::Value)>> {
    let next = tokio::select! {
        _ = &mut *cancel_rx => return Err(anyhow::anyhow!("cancelled")),
        next = lines.next_line() => next,
    };

    let Some(line) = next? else {
        return Ok(None);
    };
    let json = serde_json::from_str::<serde_json::Value>(&line)?;
    Ok(Some((line, json)))
}

fn jsonrpc_id_matches(value: &serde_json::Value, expected: i64) -> bool {
    let Some(id) = value.get("id") else {
        return false;
    };
    match id {
        serde_json::Value::Number(n) => n.as_i64() == Some(expected),
        serde_json::Value::String(s) => s == expected.to_string().as_str(),
        _ => false,
    }
}

async fn persist_and_emit_stdout(
    state: &AppState,
    session_id: &str,
    events_file: &mut tokio::fs::File,
    raw: &str,
    json: serde_json::Value,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;

    if let Some(method) = json.get("method").and_then(|v| v.as_str()) {
        if method == "thread/tokenUsage/updated"
            || method == "account/rateLimits/updated"
            || method == "item/reasoning/summaryPartAdded"
        {
            return Ok(());
        }
    }

    let ts_ms = now_ms();
    let mut persisted = json.clone();
    if let Some(obj) = persisted.as_object_mut() {
        obj.insert("_ts_ms".to_string(), serde_json::Value::Number(ts_ms.into()));
    }
    events_file.write_all(persisted.to_string().as_bytes()).await?;
    events_file.write_all(b"\n").await?;

    broadcast_ui_event(
        state,
        UiEvent {
            session_id: session_id.to_string(),
            ts_ms,
            stream: "stdout".to_string(),
            raw: raw.to_string(),
            json: Some(json),
        },
    )
    .await;
    Ok(())
}

fn capture_agent_message_text(
    msg: &serde_json::Value,
    agent_item_id: &mut Option<String>,
    agent_text: &mut String,
) {
    let Some(method) = msg.get("method").and_then(|v| v.as_str()) else {
        return;
    };
    if method == "item/agentMessage/delta" {
        let Some(params) = msg.get("params") else {
            return;
        };
        let Some(item_id) = params.get("itemId").and_then(|v| v.as_str()) else {
            return;
        };
        let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or_default();
        if agent_item_id.as_deref() != Some(item_id) {
            agent_text.clear();
            *agent_item_id = Some(item_id.to_string());
        }
        agent_text.push_str(delta);
        return;
    }

    if method == "item/completed" {
        let Some(params) = msg.get("params") else {
            return;
        };
        let Some(item) = params.get("item") else {
            return;
        };
        if item.get("type").and_then(|v| v.as_str()) != Some("agentMessage") {
            return;
        }
        let item_id = item.get("id").and_then(|v| v.as_str());
        let text = item.get("text").and_then(|v| v.as_str());
        let Some(text) = text else {
            return;
        };
        agent_text.clear();
        agent_text.push_str(text);
        *agent_item_id = item_id.map(|s| s.to_string());
    }
}

#[derive(Clone, Copy)]
struct TokenUsageSnapshot {
    window: u64,
    total_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    cached_input_tokens: u64,
    pct_left: u8,
}

fn json_u64(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
}

fn extract_token_usage_snapshot(msg: &serde_json::Value) -> Option<TokenUsageSnapshot> {
    if msg.get("method").and_then(|v| v.as_str()) != Some("thread/tokenUsage/updated") {
        return None;
    }
    let params = msg.get("params")?;
    let usage = params.get("tokenUsage")?;
    let window = params
        .get("modelContextWindow")
        .and_then(json_u64)
        .or_else(|| usage.get("modelContextWindow").and_then(json_u64))
        .unwrap_or(0);
    if window == 0 {
        return None;
    }
    let last = usage.get("last").or_else(|| usage.get("total"))?;
    let input_tokens = last.get("inputTokens").and_then(json_u64).unwrap_or(0);
    let cached_input_tokens = last.get("cachedInputTokens").and_then(json_u64).unwrap_or(0);
    let output_tokens = last.get("outputTokens").and_then(json_u64).unwrap_or(0);
    let reasoning_output_tokens = last
        .get("reasoningOutputTokens")
        .and_then(json_u64)
        .unwrap_or(0);
    let total_tokens = last
        .get("totalTokens")
        .and_then(json_u64)
        .or_else(|| {
            let sum = input_tokens + output_tokens + reasoning_output_tokens;
            (sum > 0).then_some(sum)
        })
        .unwrap_or(0);

    let remaining = window.saturating_sub(total_tokens);
    let pct_left = ((remaining.saturating_mul(100) + (window / 2)) / window).min(100) as u8;

    Some(TokenUsageSnapshot {
        window,
        total_tokens,
        input_tokens,
        output_tokens,
        reasoning_output_tokens,
        cached_input_tokens,
        pct_left,
    })
}

async fn persist_context_metrics(meta_path: &Path, snapshot: TokenUsageSnapshot) {
    let Some(mut meta) = read_meta(meta_path).await else {
        return;
    };
    meta.context_window = Some(snapshot.window);
    meta.context_used_tokens = Some(snapshot.total_tokens);
    meta.context_left_pct = Some(snapshot.pct_left);
    let _ = write_meta(meta_path, &meta).await;
}

async fn append_usage_record(state: &AppState, record: &UsageRecord) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let path = state.data_dir.join("usage.jsonl");
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    let line = serde_json::to_string(record)?;
    file.write_all(line.as_bytes()).await?;
    file.write_all(b"\n").await?;
    Ok(())
}

async fn wait_for_app_server_response(
    state: &AppState,
    lines: &mut tokio::io::Lines<BufReader<ChildStdout>>,
    cancel_rx: &mut oneshot::Receiver<()>,
    session_id: &str,
    events_file: &mut tokio::fs::File,
    expected_id: i64,
    agent_item_id: &mut Option<String>,
    agent_text: &mut String,
) -> anyhow::Result<serde_json::Value> {
    loop {
        let Some((raw, json)) = read_next_json_line(lines, cancel_rx).await? else {
            anyhow::bail!("codex app-server stdout closed");
        };
        if json.get("method").and_then(|v| v.as_str()).is_some() {
            let _ = persist_and_emit_stdout(state, session_id, events_file, &raw, json.clone()).await;
            capture_agent_message_text(&json, agent_item_id, agent_text);
            continue;
        }
        if !jsonrpc_id_matches(&json, expected_id) {
            continue;
        }
        if let Some(err) = json.get("error") {
            anyhow::bail!(err.to_string());
        }
        let Some(result) = json.get("result") else {
            anyhow::bail!("missing result");
        };
        return Ok(result.clone());
    }
}

async fn stream_stderr(
    state: AppState,
    session_id: String,
    mut reader: tokio::process::ChildStderr,
    stderr_path: PathBuf,
) {
    use tokio::io::AsyncWriteExt;
    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .await
    {
        Ok(f) => f,
        Err(_) => return,
    };

    let mut lines = BufReader::new(&mut reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let _ = file.write_all(line.as_bytes()).await;
        let _ = file.write_all(b"\n").await;
        broadcast_ui_event(
            &state,
            UiEvent {
                session_id: session_id.clone(),
                ts_ms: now_ms(),
                stream: "stderr".to_string(),
                raw: line,
                json: None,
            },
        )
        .await;
    }
}

async fn run_turn_via_app_server(
    state: AppState,
    session_id: String,
    codex: PathBuf,
    cwd: Option<String>,
    thread_id: Option<String>,
    prompt_text: String,
    events_path: PathBuf,
    stderr_path: PathBuf,
    conclusion_path: PathBuf,
    meta_path: PathBuf,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    async fn fail_and_finish(
        state: &AppState,
        session_id: String,
        meta_path: &Path,
        stderr_path: &Path,
        conclusion_path: &Path,
        error: String,
        exit_code: Option<i32>,
    ) {
        let _ = tokio::fs::write(stderr_path, format!("{error}\n")).await;
        let _ = tokio::fs::write(conclusion_path, format!("# Error\n\n{error}\n")).await;
        if let Some(mut meta) = read_meta(meta_path).await {
            meta.status = SessionStatus::Error;
            let _ = write_meta(meta_path, &meta).await;
        }
        {
            let mut locked = state.runs.lock().await;
            locked.remove(&session_id);
        }
        broadcast_run_finished(
            state,
            RunFinished {
                session_id,
                ts_ms: now_ms(),
                exit_code,
                success: false,
            },
        )
        .await;
    }

    let mut cmd = Command::new(codex);
    cmd.arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            fail_and_finish(
                &state,
                session_id,
                &meta_path,
                &stderr_path,
                &conclusion_path,
                format!("Failed to start codex app-server: {e}"),
                Some(1),
            )
            .await;
            return;
        }
    };

    if let Some(pid) = child.id() {
        let mut locked = state.runs.lock().await;
        if let Some(handle) = locked.get_mut(&session_id) {
            handle.pid = Some(pid);
        }
    }

    let mut stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            fail_and_finish(
                &state,
                session_id,
                &meta_path,
                &stderr_path,
                &conclusion_path,
                "Failed to capture app-server stdin".to_string(),
                Some(1),
            )
            .await;
            return;
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            fail_and_finish(
                &state,
                session_id,
                &meta_path,
                &stderr_path,
                &conclusion_path,
                "Failed to capture app-server stdout".to_string(),
                Some(1),
            )
            .await;
            return;
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            fail_and_finish(
                &state,
                session_id,
                &meta_path,
                &stderr_path,
                &conclusion_path,
                "Failed to capture app-server stderr".to_string(),
                Some(1),
            )
            .await;
            return;
        }
    };

    let state_for_stderr = state.clone();
    let session_id_for_stderr = session_id.clone();
    let stderr_path_for_stderr = stderr_path.clone();
    tokio::spawn(async move {
        stream_stderr(state_for_stderr, session_id_for_stderr, stderr, stderr_path_for_stderr).await;
    });

    let mut events_file = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&events_path)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            let _ = child.kill().await;
            fail_and_finish(
                &state,
                session_id,
                &meta_path,
                &stderr_path,
                &conclusion_path,
                format!("Failed to open events.jsonl: {e}"),
                Some(1),
            )
            .await;
            return;
        }
    };

    let mut lines = BufReader::new(stdout).lines();

    let mut next_id: i64 = 1;
    let mut agent_item_id: Option<String> = None;
    let mut agent_text = String::new();
    let mut effective_thread_id = thread_id.clone();

    let init_id = next_id;
    next_id += 1;
    if let Err(e) = write_jsonrpc_request(
        &mut stdin,
        init_id,
        "initialize",
        serde_json::json!({
            "clientInfo": {
                "name": "codex-warp-server",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }),
    )
    .await
    {
        let _ = child.kill().await;
        fail_and_finish(
            &state,
            session_id,
            &meta_path,
            &stderr_path,
            &conclusion_path,
            format!("Failed to send initialize request: {e}"),
            Some(1),
        )
        .await;
        return;
    }

    if let Err(e) = wait_for_app_server_response(
        &state,
        &mut lines,
        &mut cancel_rx,
        &session_id,
        &mut events_file,
        init_id,
        &mut agent_item_id,
        &mut agent_text,
    )
    .await
    {
        let _ = child.kill().await;
        let (exit_code, error) = if e.to_string() == "cancelled" {
            (None, "Cancelled.".to_string())
        } else {
            (Some(1), format!("Initialize failed: {e}"))
        };
        fail_and_finish(
            &state,
            session_id,
            &meta_path,
            &stderr_path,
            &conclusion_path,
            error,
            exit_code,
        )
        .await;
        return;
    }

    // Resume existing Codex thread if available; otherwise start a new one.
    if let Some(existing) = thread_id.clone() {
        let resume_id = next_id;
        next_id += 1;
        let _ = write_jsonrpc_request(
            &mut stdin,
            resume_id,
            "thread/resume",
            serde_json::json!({
                "threadId": existing,
                "cwd": cwd.clone(),
                "config": { "skip_git_repo_check": true },
            }),
        )
        .await;

        match wait_for_app_server_response(
            &state,
            &mut lines,
            &mut cancel_rx,
            &session_id,
            &mut events_file,
            resume_id,
            &mut agent_item_id,
            &mut agent_text,
        )
        .await
        {
            Ok(result) => {
                if let Some(id) = result
                    .get("thread")
                    .and_then(|v| v.get("id"))
                    .and_then(|v| v.as_str())
                {
                    effective_thread_id = Some(id.to_string());
                }
            }
            Err(e) if e.to_string() == "cancelled" => {
                let _ = child.kill().await;
                fail_and_finish(
                    &state,
                    session_id,
                    &meta_path,
                    &stderr_path,
                    &conclusion_path,
                    "Cancelled.".to_string(),
                    None,
                )
                .await;
                return;
            }
            Err(_) => {
                effective_thread_id = None;
            }
        }
    }

    if effective_thread_id.is_none() {
        let start_id = next_id;
        next_id += 1;
        let _ = write_jsonrpc_request(
            &mut stdin,
            start_id,
            "thread/start",
            serde_json::json!({
                "cwd": cwd.clone(),
                "config": { "skip_git_repo_check": true },
            }),
        )
        .await;

        match wait_for_app_server_response(
            &state,
            &mut lines,
            &mut cancel_rx,
            &session_id,
            &mut events_file,
            start_id,
            &mut agent_item_id,
            &mut agent_text,
        )
        .await
        {
            Ok(result) => {
                if let Some(id) = result
                    .get("thread")
                    .and_then(|v| v.get("id"))
                    .and_then(|v| v.as_str())
                {
                    effective_thread_id = Some(id.to_string());
                }
            }
            Err(e) => {
                let _ = child.kill().await;
                let (exit_code, error) = if e.to_string() == "cancelled" {
                    (None, "Cancelled.".to_string())
                } else {
                    (Some(1), format!("Thread start failed: {e}"))
                };
                fail_and_finish(
                    &state,
                    session_id,
                    &meta_path,
                    &stderr_path,
                    &conclusion_path,
                    error,
                    exit_code,
                )
                .await;
                return;
            }
        }
    }

    let Some(thread_id) = effective_thread_id.clone() else {
        let _ = child.kill().await;
        fail_and_finish(
            &state,
            session_id,
            &meta_path,
            &stderr_path,
            &conclusion_path,
            "Thread start did not return a thread id".to_string(),
            Some(1),
        )
        .await;
        return;
    };

    if let Some(mut meta) = read_meta(&meta_path).await {
        if meta.codex_session_id.as_deref() != Some(thread_id.as_str()) {
            meta.codex_session_id = Some(thread_id.clone());
            let _ = write_meta(&meta_path, &meta).await;
        }
    }

    let turn_start_id = next_id;
    next_id += 1;
    let _ = write_jsonrpc_request(
        &mut stdin,
        turn_start_id,
        "turn/start",
        serde_json::json!({
            "threadId": thread_id,
            "input": [ { "type": "text", "text": prompt_text } ],
        }),
    )
    .await;

    let turn_id_for_interrupt = match wait_for_app_server_response(
        &state,
        &mut lines,
        &mut cancel_rx,
        &session_id,
        &mut events_file,
        turn_start_id,
        &mut agent_item_id,
        &mut agent_text,
    )
    .await
    {
        Ok(result) => result
            .get("turn")
            .and_then(|v| v.get("id"))
            .and_then(|v| match v {
                serde_json::Value::String(s) => Some(s.to_string()),
                serde_json::Value::Number(n) => n.as_i64().map(|i| i.to_string()),
                _ => None,
            }),
        Err(e) => {
            let _ = child.kill().await;
            let (exit_code, error) = if e.to_string() == "cancelled" {
                (None, "Cancelled.".to_string())
            } else {
                (Some(1), format!("Turn start failed: {e}"))
            };
            fail_and_finish(
                &state,
                session_id,
                &meta_path,
                &stderr_path,
                &conclusion_path,
                error,
                exit_code,
            )
            .await;
            return;
        }
    };

    let mut cancelled = false;
    let mut success = false;
    let mut exit_code: Option<i32> = Some(1);
    let mut last_metrics_emit_ms: u64 = 0;
    let mut last_metrics_emitted_pct: Option<u8> = None;
    let mut last_usage_snapshot: Option<TokenUsageSnapshot> = None;

    loop {
        let next = read_next_json_line(&mut lines, &mut cancel_rx).await;
        let (raw, json) = match next {
            Ok(Some(v)) => v,
            Ok(None) => break,
            Err(e) => {
                cancelled = e.to_string() == "cancelled";
                break;
            }
        };

        let Some(method) = json.get("method").and_then(|v| v.as_str()) else {
            continue;
        };

        if method == "thread/tokenUsage/updated" {
            if let Some(snapshot) = extract_token_usage_snapshot(&json) {
                last_usage_snapshot = Some(snapshot);
                if last_metrics_emitted_pct != Some(snapshot.pct_left) {
                    let now = now_ms();
                    if last_metrics_emit_ms == 0 || now.saturating_sub(last_metrics_emit_ms) >= 5_000 {
                        persist_context_metrics(&meta_path, snapshot).await;
                        broadcast_metrics(
                            &state,
                            ContextMetrics {
                                session_id: session_id.clone(),
                                ts_ms: now,
                                context_left_pct: snapshot.pct_left,
                                context_used_tokens: snapshot.total_tokens,
                                context_window: snapshot.window,
                            },
                        )
                        .await;
                        last_metrics_emit_ms = now;
                        last_metrics_emitted_pct = Some(snapshot.pct_left);
                    }
                }
            }
        }

        let _ = persist_and_emit_stdout(&state, &session_id, &mut events_file, &raw, json.clone()).await;
        capture_agent_message_text(&json, &mut agent_item_id, &mut agent_text);

        if method == "turn/completed" {
            let status = json
                .get("params")
                .and_then(|v| v.get("turn"))
                .and_then(|v| v.get("status"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            success = status == "completed";
            exit_code = if success { None } else if status == "interrupted" { None } else { Some(1) };
            break;
        }
    }

    if cancelled {
        exit_code = None;
        if let (Some(thread_id), Some(turn_id)) = (effective_thread_id.as_deref(), turn_id_for_interrupt.as_deref()) {
            let interrupt_id = next_id;
            let _ = write_jsonrpc_request(
                &mut stdin,
                interrupt_id,
                "turn/interrupt",
                serde_json::json!({ "threadId": thread_id, "turnId": turn_id }),
            )
            .await;
        }
        success = false;
    }

    if let Some(snapshot) = last_usage_snapshot {
        let now = now_ms();
        persist_context_metrics(&meta_path, snapshot).await;
        broadcast_metrics(
            &state,
            ContextMetrics {
                session_id: session_id.clone(),
                ts_ms: now,
                context_left_pct: snapshot.pct_left,
                context_used_tokens: snapshot.total_tokens,
                context_window: snapshot.window,
            },
        )
        .await;
        let _ = append_usage_record(
            &state,
            &UsageRecord {
                ts_ms: now,
                session_id: session_id.clone(),
                thread_id: effective_thread_id.clone(),
                total_tokens: snapshot.total_tokens,
                input_tokens: snapshot.input_tokens,
                output_tokens: snapshot.output_tokens,
                reasoning_output_tokens: snapshot.reasoning_output_tokens,
                cached_input_tokens: snapshot.cached_input_tokens,
                context_window: snapshot.window,
            },
        )
        .await;
    }

    if !agent_text.trim().is_empty() {
        let _ = tokio::fs::write(&conclusion_path, agent_text).await;
    }

    drop(stdin);
    match timeout(Duration::from_secs(2), child.wait()).await {
        Ok(_) => {}
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    {
        let mut locked = state.runs.lock().await;
        locked.remove(&session_id);
    }

    if let Some(mut meta) = read_meta(&meta_path).await {
        meta.status = if success { SessionStatus::Done } else { SessionStatus::Error };
        let _ = write_meta(&meta_path, &meta).await;
    }

    broadcast_run_finished(
        &state,
        RunFinished {
            session_id,
            ts_ms: now_ms(),
            exit_code,
            success,
        },
    )
    .await;
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let args = Args::parse();
    let bind: SocketAddr = args
        .bind
        .parse()
        .context("invalid --bind (expected ip:port)")?;

    let data_dir = match args.data_dir {
        Some(p) => PathBuf::from(p),
        None => default_data_dir().context("unable to determine default data dir")?,
    };
    tokio::fs::create_dir_all(&data_dir)
        .await
        .context("create data_dir")?;

    let codex_path = args
        .codex_path
        .and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() { None } else { Some(PathBuf::from(t)) }
        });

    let codex_home = match args.codex_home {
        Some(raw) => {
            let t = raw.trim().to_string();
            if t.is_empty() {
                default_codex_home()
            } else {
                Some(PathBuf::from(t))
            }
        }
        None => default_codex_home(),
    };

    let state = AppState {
        data_dir,
        codex_path,
        codex_home,
        runs: Arc::new(Mutex::new(HashMap::new())),
        streams: Arc::new(Mutex::new(HashMap::new())),
        native_cache: Arc::new(Mutex::new(NativeCache {
            built_at_ms: 0,
            rollouts_by_session: HashMap::new(),
            derived_by_session: HashMap::new(),
        })),
    };

    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/skills", get(list_skills))
        .route("/api/usage", get(list_usage_records))
        .route("/api/sessions", get(list_sessions).post(start_session))
        .route("/api/sessions/:id/touch", post(touch_session))
        .route("/api/sessions/:id/turn", post(continue_session))
        .route("/api/sessions/:id/stop", post(stop_session))
        .route("/api/sessions/:id/rename", post(rename_session))
        .route("/api/sessions/:id/conclusion", get(read_conclusion))
        .route("/api/sessions/:id/stream", get(stream_session))
        .route("/api/sessions/:id", delete(delete_session))
        .layer(CorsLayer::very_permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let web_dist = args.web_dist.map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
    });
    let index_html = web_dist.join("index.html");
    if index_html.is_file() {
        let serve_dir = ServeDir::new(web_dist).not_found_service(ServeFile::new(index_html));
        app = app.fallback_service(serve_dir);
    } else {
        app = app.route(
            "/",
            get(|| async {
                "UI not built. Run `npm run build` in the repo root to generate dist/."
            }),
        );
    }

    info!("listening on http://{bind}");
    axum::serve(tokio::net::TcpListener::bind(bind).await?, app).await?;
    Ok(())
}
