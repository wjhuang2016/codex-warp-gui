use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
    sync::{oneshot, Mutex},
    time::{timeout, Duration},
};
use uuid::Uuid;

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
    events_path: String,
    stderr_path: String,
    conclusion_path: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct Settings {
    codex_path: Option<String>,
    default_cwd: Option<String>,
    last_cwd: Option<String>,
}

struct RunHandle {
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct AppState {
    runs: Arc<Mutex<HashMap<String, RunHandle>>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("sessions"))
}

fn session_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    Ok(sessions_root(app)?.join(session_id))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("settings.json"))
}

async fn read_settings(app: &AppHandle) -> Settings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return Settings::default(),
    };

    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(_) => return Settings::default(),
    };

    serde_json::from_slice(&bytes).unwrap_or_default()
}

async fn write_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(
        path,
        serde_json::to_vec_pretty(settings).unwrap_or_default(),
    )
    .await
    .map_err(|e| e.to_string())
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

fn push_unique(out: &mut Vec<PathBuf>, path: PathBuf) {
    if out.iter().any(|p| p == &path) {
        return;
    }
    out.push(path);
}

fn detect_codex_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();

    // PATH lookup first.
    if let Some(path_env) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let cand = dir.join("codex");
            if is_executable(&cand) {
                push_unique(&mut out, cand);
            }
        }
    }

    // Common global install locations.
    for cand in [
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/usr/bin/codex"),
    ] {
        if is_executable(&cand) {
            push_unique(&mut out, cand);
        }
    }

    // User-level locations (nvm/asdf/pnpm).
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);

        let asdf = home.join(".asdf/shims/codex");
        if is_executable(&asdf) {
            push_unique(&mut out, asdf);
        }

        let local_bin = home.join(".local/bin/codex");
        if is_executable(&local_bin) {
            push_unique(&mut out, local_bin);
        }

        let pnpm = home.join("Library/pnpm/codex");
        if is_executable(&pnpm) {
            push_unique(&mut out, pnpm);
        }

        let nvm_root = home.join(".nvm/versions/node");
        if let Ok(rd) = std::fs::read_dir(&nvm_root) {
            let mut entries = rd.flatten().collect::<Vec<_>>();
            entries.sort_by_key(|e| e.file_name());
            entries.reverse();

            for entry in entries {
                let cand = entry.path().join("bin/codex");
                if is_executable(&cand) {
                    push_unique(&mut out, cand);
                }
            }
        }
    }

    out
}

async fn resolve_codex_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = read_settings(app).await;
    if let Some(path) = settings.codex_path {
        let path = PathBuf::from(path);
        if is_executable(&path) {
            return Ok(path);
        }
        return Err(format!(
            "Configured codex_path is not executable: {}",
            path.display()
        ));
    }

    let candidates = detect_codex_paths();
    if let Some(path) = candidates.into_iter().next() {
        return Ok(path);
    }

    Err(
        "codex executable not found. Install codex CLI or configure codex_path in Settings."
            .to_string(),
    )
}

async fn read_meta(path: &Path) -> Option<SessionMeta> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let mut meta: SessionMeta = serde_json::from_slice(&bytes).ok()?;
    if meta.last_used_at_ms == 0 {
        meta.last_used_at_ms = meta.created_at_ms;
    }
    Some(meta)
}

async fn write_meta(path: &Path, meta: &SessionMeta) -> Result<(), String> {
    tokio::fs::write(path, serde_json::to_vec_pretty(meta).unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

async fn try_find_codex_session_id(events_path: &Path) -> Option<String> {
    let file = tokio::fs::File::open(events_path).await.ok()?;
    let mut lines = BufReader::new(file).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let json = serde_json::from_str::<serde_json::Value>(&line).ok()?;
        if json.get("type").and_then(|v| v.as_str()) == Some("thread.started") {
            let thread_id = json.get("thread_id").and_then(|v| v.as_str())?;
            return Some(thread_id.to_string());
        }
        if json.get("method").and_then(|v| v.as_str()) == Some("thread/started") {
            let params = json.get("params")?;
            let thread_id = params.get("threadId").and_then(|v| v.as_str())?;
            return Some(thread_id.to_string());
        }
    }

    None
}

fn strip_tool_citations(text: &str) -> String {
    // Some OpenAI tool annotations are encoded using private-use Unicode characters
    // like `\u{E200}` ... `\u{E201}` (e.g. citations). In a plain-text GUI these can
    // show up as "garbled" glyph boxes, so we remove them for the conclusion file.
    const START: &str = "\u{E200}";
    const END: &str = "\u{E201}";

    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(START) {
        out.push_str(&rest[..start]);
        while out.ends_with(' ') || out.ends_with('\t') {
            out.pop();
        }
        let after_start = &rest[start + START.len()..];
        if let Some(end_rel) = after_start.find(END) {
            rest = &after_start[end_rel + END.len()..];
        } else {
            return out;
        }
    }
    out.push_str(rest);
    out
}

async fn update_conclusion_from_events(dir: &Path) -> Result<(), String> {
    let events_path = dir.join("events.jsonl");
    let file = match tokio::fs::File::open(&events_path).await {
        Ok(f) => f,
        Err(_) => return Ok(()),
    };

    let mut last_message: Option<String> = None;
    let mut lines = BufReader::new(file).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let json = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = json
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if !ty.starts_with("item.") {
            // app-server protocol uses notifications with `method` + `params`.
            if json.get("method").and_then(|v| v.as_str()) != Some("item/completed") {
                continue;
            }
            let Some(params) = json.get("params") else {
                continue;
            };
            let Some(item) = params.get("item") else {
                continue;
            };
            if item.get("type").and_then(|v| v.as_str()) != Some("agentMessage") {
                continue;
            }
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                last_message = Some(text.to_string());
            }
            continue;
        }
        let Some(item) = json.get("item") else {
            continue;
        };
        if item.get("type").and_then(|v| v.as_str()) != Some("agent_message") {
            continue;
        }
        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
            last_message = Some(text.to_string());
        }
    }

    if let Some(text) = last_message {
        let cleaned = strip_tool_citations(&text);
        tokio::fs::write(dir.join("conclusion.md"), cleaned)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn safe_title(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return "New session".to_string();
    }
    let mut s = trimmed.replace('\n', " ");
    if s.len() > 60 {
        s.truncate(60);
        s.push('…');
    }
    s
}

async fn write_jsonrpc_request(
    stdin: &mut ChildStdin,
    id: i64,
    method: &str,
    params: serde_json::Value,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let msg = serde_json::json!({
        "id": id,
        "method": method,
        "params": params,
    });
    let line = msg.to_string();
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn read_next_json_line(
    lines: &mut tokio::io::Lines<BufReader<ChildStdout>>,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> Result<Option<(String, serde_json::Value)>, String> {
    let next = tokio::select! {
        _ = &mut *cancel_rx => return Err("cancelled".to_string()),
        next = lines.next_line() => next,
    };

    let Some(line) = next.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let json = serde_json::from_str::<serde_json::Value>(&line).map_err(|e| e.to_string())?;
    Ok(Some((line, json)))
}

async fn persist_and_emit_stdout(
    app: &AppHandle,
    session_id: &str,
    events_file: &mut tokio::fs::File,
    raw: &str,
    json: serde_json::Value,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    events_file
        .write_all(raw.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    events_file
        .write_all(b"\n")
        .await
        .map_err(|e| e.to_string())?;

    let payload = UiEvent {
        session_id: session_id.to_string(),
        ts_ms: now_ms(),
        stream: "stdout".to_string(),
        raw: raw.to_string(),
        json: Some(json),
    };
    let _ = app.emit("codex_event", payload);
    Ok(())
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

async fn wait_for_app_server_response(
    lines: &mut tokio::io::Lines<BufReader<ChildStdout>>,
    cancel_rx: &mut oneshot::Receiver<()>,
    app: &AppHandle,
    session_id: &str,
    events_file: &mut tokio::fs::File,
    expected_id: i64,
    agent_item_id: &mut Option<String>,
    agent_text: &mut String,
) -> Result<serde_json::Value, String> {
    loop {
        let Some((raw, json)) = read_next_json_line(lines, cancel_rx).await? else {
            return Err("codex app-server stdout closed".to_string());
        };
        if json.get("method").and_then(|v| v.as_str()).is_some() {
            let _ = persist_and_emit_stdout(app, session_id, events_file, &raw, json.clone()).await;
            capture_agent_message_text(&json, agent_item_id, agent_text);
            continue;
        }
        if !jsonrpc_id_matches(&json, expected_id) {
            continue;
        }
        if let Some(err) = json.get("error") {
            return Err(err.to_string());
        }
        let Some(result) = json.get("result") else {
            return Err("missing result".to_string());
        };
        return Ok(result.clone());
    }
}

async fn stream_lines<R: tokio::io::AsyncRead + Unpin>(
    app: AppHandle,
    session_id: String,
    stream_name: String,
    reader: R,
    events_path: PathBuf,
    emit_json: bool,
) {
    use tokio::io::AsyncWriteExt;

    let meta_path = session_dir(&app, &session_id)
        .ok()
        .map(|dir| dir.join("meta.json"));
    let mut lines = BufReader::new(reader).lines();
    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&events_path)
        .await
    {
        Ok(f) => f,
        Err(_) => return,
    };

    let mut wrote_codex_session_id = false;
    let mut pending_thread_id: Option<String> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        let _ = file.write_all(line.as_bytes()).await;
        let _ = file.write_all(b"\n").await;

        let json = if emit_json {
            serde_json::from_str::<serde_json::Value>(&line).ok()
        } else {
            None
        };

        if emit_json && pending_thread_id.is_none() {
            pending_thread_id = json.as_ref().and_then(|v| v.as_object()).and_then(|obj| {
                (obj.get("type").and_then(|v| v.as_str()) == Some("thread.started"))
                    .then_some(obj.get("thread_id")?.as_str()?.to_string())
            });
        }

        if emit_json && !wrote_codex_session_id {
            if let (Some(meta_path), Some(thread_id)) =
                (meta_path.as_ref(), pending_thread_id.as_ref())
            {
                if let Some(mut meta) = read_meta(meta_path).await {
                    if meta.codex_session_id.is_none() {
                        meta.codex_session_id = Some(thread_id.clone());
                        if write_meta(meta_path, &meta).await.is_ok() {
                            wrote_codex_session_id = true;
                            pending_thread_id = None;
                        }
                    } else {
                        wrote_codex_session_id = true;
                        pending_thread_id = None;
                    }
                }
            }
        }

        let payload = UiEvent {
            session_id: session_id.clone(),
            ts_ms: now_ms(),
            stream: stream_name.clone(),
            raw: line,
            json,
        };
        let _ = app.emit("codex_event", payload);
    }
}

async fn run_turn_via_app_server(
    app: AppHandle,
    runs: Arc<Mutex<HashMap<String, RunHandle>>>,
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
        app: &AppHandle,
        runs: &Arc<Mutex<HashMap<String, RunHandle>>>,
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
            let mut locked = runs.lock().await;
            locked.remove(&session_id);
        }
        let _ = app.emit(
            "codex_run_finished",
            RunFinished {
                session_id,
                ts_ms: now_ms(),
                exit_code,
                success: false,
            },
        );
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
                &app,
                &runs,
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

    let mut stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            fail_and_finish(
                &app,
                &runs,
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
                &app,
                &runs,
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
                &app,
                &runs,
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

    let app_for_stderr = app.clone();
    let session_id_for_stderr = session_id.clone();
    let stderr_path_for_stderr = stderr_path.clone();
    tokio::spawn(async move {
        stream_lines(
            app_for_stderr,
            session_id_for_stderr,
            "stderr".to_string(),
            stderr,
            stderr_path_for_stderr,
            false,
        )
        .await;
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
                &app,
                &runs,
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
                "name": "codex-warp-gui",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }),
    )
    .await
    {
        let _ = child.kill().await;
        fail_and_finish(
            &app,
            &runs,
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
        &mut lines,
        &mut cancel_rx,
        &app,
        &session_id,
        &mut events_file,
        init_id,
        &mut agent_item_id,
        &mut agent_text,
    )
    .await
    {
        let _ = child.kill().await;
        let (exit_code, error) = if e == "cancelled" {
            (None, "Cancelled.".to_string())
        } else {
            (Some(1), format!("Initialize failed: {e}"))
        };
        fail_and_finish(
            &app,
            &runs,
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
                "approvalPolicy": "never",
                "sandbox": "workspace-write",
                "cwd": cwd.clone(),
                "config": { "skip_git_repo_check": true },
            }),
        )
        .await;

        match wait_for_app_server_response(
            &mut lines,
            &mut cancel_rx,
            &app,
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
            Err(e) if e == "cancelled" => {
                let _ = child.kill().await;
                fail_and_finish(
                    &app,
                    &runs,
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
                // Fall back to starting a fresh Codex thread.
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
                "approvalPolicy": "never",
                "sandbox": "workspace-write",
                "cwd": cwd.clone(),
                "config": { "skip_git_repo_check": true },
            }),
        )
        .await;

        match wait_for_app_server_response(
            &mut lines,
            &mut cancel_rx,
            &app,
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
                let (exit_code, error) = if e == "cancelled" {
                    (None, "Cancelled.".to_string())
                } else {
                    (Some(1), format!("Thread start failed: {e}"))
                };
                fail_and_finish(
                    &app,
                    &runs,
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
            &app,
            &runs,
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
            "approvalPolicy": "never",
            "input": [ { "type": "text", "text": prompt_text } ],
        }),
    )
    .await;

    let turn_id_for_interrupt = match wait_for_app_server_response(
        &mut lines,
        &mut cancel_rx,
        &app,
        &session_id,
        &mut events_file,
        turn_start_id,
        &mut agent_item_id,
        &mut agent_text,
    )
    .await
    {
        Ok(result) => {
            result
                .get("turn")
                .and_then(|v| v.get("id"))
                .and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s.to_string()),
                    serde_json::Value::Number(n) => n.as_i64().map(|i| i.to_string()),
                    _ => None,
                })
        }
        Err(e) => {
            let _ = child.kill().await;
            let (exit_code, error) = if e == "cancelled" {
                (None, "Cancelled.".to_string())
            } else {
                (Some(1), format!("Turn start failed: {e}"))
            };
            fail_and_finish(
                &app,
                &runs,
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

    loop {
        let next = read_next_json_line(&mut lines, &mut cancel_rx).await;
        let (raw, json) = match next {
            Ok(Some(v)) => v,
            Ok(None) => break,
            Err(msg) => {
                cancelled = msg == "cancelled";
                break;
            }
        };

        let Some(method) = json.get("method").and_then(|v| v.as_str()) else {
            continue;
        };
        let _ = persist_and_emit_stdout(&app, &session_id, &mut events_file, &raw, json.clone())
            .await;
        capture_agent_message_text(&json, &mut agent_item_id, &mut agent_text);

        if method == "turn/completed" {
            let status = json
                .get("params")
                .and_then(|v| v.get("turn"))
                .and_then(|v| v.get("status"))
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            success = status == "completed";
            exit_code = if success {
                None
            } else if status == "interrupted" {
                None
            } else {
                Some(1)
            };
            break;
        }
    }

    if cancelled {
        exit_code = None;
        if let (Some(thread_id), Some(turn_id)) =
            (effective_thread_id.as_deref(), turn_id_for_interrupt.as_deref())
        {
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

    let cleaned_agent_text = strip_tool_citations(&agent_text);
    if !cleaned_agent_text.trim().is_empty() {
        let _ = tokio::fs::write(&conclusion_path, cleaned_agent_text).await;
    } else if let Some(dir) = meta_path.parent() {
        let _ = update_conclusion_from_events(dir).await;
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
        let mut locked = runs.lock().await;
        locked.remove(&session_id);
    }
    if let Some(mut meta) = read_meta(&meta_path).await {
        meta.status = if success {
            SessionStatus::Done
        } else {
            SessionStatus::Error
        };
        let _ = write_meta(&meta_path, &meta).await;
    }

    let payload = RunFinished {
        session_id,
        ts_ms: now_ms(),
        exit_code,
        success,
    };
    let _ = app.emit("codex_run_finished", payload);
}

#[tauri::command]
async fn start_run(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
    prompt: String,
    cwd: Option<String>,
) -> Result<SessionMeta, String> {
    let session_id = match session_id {
        Some(s) => Uuid::parse_str(s.trim())
            .map_err(|_| "invalid session id".to_string())?
            .to_string(),
        None => Uuid::new_v4().to_string(),
    };
    let created_at_ms = now_ms();
    let last_used_at_ms = created_at_ms;

    let dir = session_dir(&app, &session_id)?;
    if tokio::fs::metadata(&dir).await.is_ok() {
        return Err("session already exists".to_string());
    }
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;

    let events_path = dir.join("events.jsonl");
    let stderr_path = dir.join("stderr.log");
    let conclusion_path = dir.join("conclusion.md");

    let mut cwd = cwd.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    if cwd.is_none() {
        let settings = read_settings(&app).await;
        if let Some(path) = settings.last_cwd.or(settings.default_cwd) {
            let t = path.trim().to_string();
            if !t.is_empty() {
                cwd = Some(t);
            }
        }
    }

    if let Some(dir) = cwd.clone() {
        let mut settings = read_settings(&app).await;
        if settings.last_cwd.as_deref() != Some(dir.as_str()) {
            settings.last_cwd = Some(dir);
            let _ = write_settings(&app, &settings).await;
        }
    }

    let codex = match resolve_codex_executable(&app).await {
        Ok(p) => p,
        Err(msg) => {
            let details = msg;
            let candidates = detect_codex_paths()
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join("\n");
            let error = if candidates.is_empty() {
                details
            } else {
                format!("{details}\n\nDetected candidates:\n{candidates}")
            };

            let _ = tokio::fs::write(&stderr_path, format!("{error}\n")).await;
            let _ = tokio::fs::write(&conclusion_path, format!("# Error\n\n{error}\n")).await;
            let _ = tokio::fs::write(
                &events_path,
                format!(
                    "{}\n",
                    serde_json::json!({
                        "type": "app/error",
                        "message": error,
                    })
                ),
            )
            .await;

            let meta = SessionMeta {
                id: session_id.clone(),
                title: safe_title(&prompt),
                created_at_ms,
                last_used_at_ms,
                cwd: cwd.clone(),
                status: SessionStatus::Error,
                codex_session_id: None,
                events_path: events_path.to_string_lossy().to_string(),
                stderr_path: stderr_path.to_string_lossy().to_string(),
                conclusion_path: conclusion_path.to_string_lossy().to_string(),
            };

            let meta_path = dir.join("meta.json");
            let _ = tokio::fs::write(
                &meta_path,
                serde_json::to_vec_pretty(&meta).unwrap_or_default(),
            )
            .await;

            let _ = app.emit(
                "codex_run_finished",
                RunFinished {
                    session_id,
                    ts_ms: now_ms(),
                    exit_code: None,
                    success: false,
                },
            );

            return Ok(meta);
        }
    };

    // Persist + emit the prompt marker early so the UI doesn't look empty while the process starts.
    let prompt_ts = now_ms();
    let prompt_event = serde_json::json!({
        "type": "app.prompt",
        "prompt": prompt.trim(),
    });
    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&events_path)
            .await
            .map_err(|e| e.to_string())?;
        let line = prompt_event.to_string();
        file.write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        file.write_all(b"\n").await.map_err(|e| e.to_string())?;
    }
    let _ = app.emit(
        "codex_event",
        UiEvent {
            session_id: session_id.clone(),
            ts_ms: prompt_ts,
            stream: "stdout".to_string(),
            raw: prompt_event.to_string(),
            json: Some(prompt_event),
        },
    );

    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut runs = state.runs.lock().await;
        runs.insert(
            session_id.clone(),
            RunHandle {
                cancel: Some(cancel_tx),
            },
        );
    }

    let meta = SessionMeta {
        id: session_id.clone(),
        title: safe_title(&prompt),
        created_at_ms,
        last_used_at_ms,
        cwd: cwd.clone(),
        status: SessionStatus::Running,
        codex_session_id: None,
        events_path: events_path.to_string_lossy().to_string(),
        stderr_path: stderr_path.to_string_lossy().to_string(),
        conclusion_path: conclusion_path.to_string_lossy().to_string(),
    };

    let meta_path = dir.join("meta.json");
    tokio::fs::write(
        &meta_path,
        serde_json::to_vec_pretty(&meta).unwrap_or_default(),
    )
    .await
    .map_err(|e| e.to_string())?;

    let app_for_run = app.clone();
    let runs = state.runs.clone();
    let session_id_for_run = session_id.clone();
    let cwd_for_run = cwd.clone();
    let prompt_text = prompt.trim().to_string();
    let events_path_for_run = events_path.clone();
    let stderr_path_for_run = stderr_path.clone();
    let conclusion_path_for_run = conclusion_path.clone();
    let meta_path_for_run = meta_path.clone();
    tokio::spawn(async move {
        run_turn_via_app_server(
            app_for_run,
            runs,
            session_id_for_run,
            codex,
            cwd_for_run,
            None,
            prompt_text,
            events_path_for_run,
            stderr_path_for_run,
            conclusion_path_for_run,
            meta_path_for_run,
            cancel_rx,
        )
        .await;
    });

    Ok(meta)
}

#[tauri::command]
async fn continue_run(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    prompt: String,
    cwd: Option<String>,
) -> Result<SessionMeta, String> {
    // Avoid multiple concurrent runs per session.
    {
        let runs = state.runs.lock().await;
        if runs.contains_key(&session_id) {
            return Err("session is already running".to_string());
        }
    }

    let dir = session_dir(&app, &session_id)?;
    let meta_path = dir.join("meta.json");
    let Some(mut meta) = read_meta(&meta_path).await else {
        return Err("meta.json not found".to_string());
    };

    let events_path = dir.join("events.jsonl");
    let stderr_path = dir.join("stderr.log");
    let conclusion_path = dir.join("conclusion.md");

    let mut cwd = cwd.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    if cwd.is_none() {
        cwd = meta.cwd.clone();
    }
    if cwd.is_none() {
        let settings = read_settings(&app).await;
        if let Some(path) = settings.last_cwd.or(settings.default_cwd) {
            let t = path.trim().to_string();
            if !t.is_empty() {
                cwd = Some(t);
            }
        }
    }

    if let Some(dir) = cwd.clone() {
        let mut settings = read_settings(&app).await;
        if settings.last_cwd.as_deref() != Some(dir.as_str()) {
            settings.last_cwd = Some(dir);
            let _ = write_settings(&app, &settings).await;
        }
    }

    if meta.codex_session_id.is_none() {
        meta.codex_session_id = try_find_codex_session_id(&events_path).await;
    }

    meta.status = SessionStatus::Running;
    meta.cwd = cwd.clone();
    meta.last_used_at_ms = now_ms();
    meta.events_path = events_path.to_string_lossy().to_string();
    meta.stderr_path = stderr_path.to_string_lossy().to_string();
    meta.conclusion_path = conclusion_path.to_string_lossy().to_string();

    write_meta(&meta_path, &meta).await?;

    let codex = resolve_codex_executable(&app).await?;

    // Persist + emit the prompt marker.
    let prompt_text = prompt.trim().to_string();
    let prompt_ts = now_ms();
    let prompt_event = serde_json::json!({
        "type": "app.prompt",
        "prompt": prompt_text.clone(),
    });
    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&events_path)
            .await
            .map_err(|e| e.to_string())?;
        let line = prompt_event.to_string();
        file.write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        file.write_all(b"\n").await.map_err(|e| e.to_string())?;
    }
    let _ = app.emit(
        "codex_event",
        UiEvent {
            session_id: session_id.clone(),
            ts_ms: prompt_ts,
            stream: "stdout".to_string(),
            raw: prompt_event.to_string(),
            json: Some(prompt_event),
        },
    );

    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut runs = state.runs.lock().await;
        runs.insert(
            session_id.clone(),
            RunHandle {
                cancel: Some(cancel_tx),
            },
        );
    }

    let app_for_run = app.clone();
    let runs = state.runs.clone();
    let session_id_for_run = session_id.clone();
    let cwd_for_run = cwd.clone();
    let thread_id_for_run = meta.codex_session_id.clone();
    let events_path_for_run = events_path.clone();
    let stderr_path_for_run = stderr_path.clone();
    let conclusion_path_for_run = conclusion_path.clone();
    let meta_path_for_run = meta_path.clone();
    tokio::spawn(async move {
        run_turn_via_app_server(
            app_for_run,
            runs,
            session_id_for_run,
            codex,
            cwd_for_run,
            thread_id_for_run,
            prompt_text,
            events_path_for_run,
            stderr_path_for_run,
            conclusion_path_for_run,
            meta_path_for_run,
            cancel_rx,
        )
        .await;
    });

    Ok(meta)
}

#[tauri::command]
async fn stop_run(state: tauri::State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut runs = state.runs.lock().await;
    let Some(handle) = runs.get_mut(&session_id) else {
        return Ok(());
    };
    if let Some(cancel) = handle.cancel.take() {
        let _ = cancel.send(());
    }
    Ok(())
}

#[tauri::command]
async fn list_sessions(app: AppHandle) -> Result<Vec<SessionMeta>, String> {
    use std::cmp::Reverse;

    let root = sessions_root(&app)?;
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| e.to_string())?;

    let mut sessions = Vec::new();
    let mut rd = tokio::fs::read_dir(&root)
        .await
        .map_err(|e| e.to_string())?;
    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let ty = entry.file_type().await.map_err(|e| e.to_string())?;
        if !ty.is_dir() {
            continue;
        }
        let meta_path = entry.path().join("meta.json");
        if let Some(meta) = read_meta(&meta_path).await {
            sessions.push(meta);
        }
    }

    sessions.sort_by_key(|s| Reverse(s.last_used_at_ms.max(s.created_at_ms)));
    Ok(sessions)
}

#[tauri::command]
async fn read_session_events(
    app: AppHandle,
    session_id: String,
    max_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    use std::collections::VecDeque;

    let dir = session_dir(&app, &session_id)?;
    let path = dir.join("events.jsonl");
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| e.to_string())?;

    let mut out = VecDeque::new();
    let mut lines = BufReader::new(file).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(max) = max_lines {
            while out.len() >= max {
                out.pop_front();
            }
        }
        out.push_back(line);
    }
    Ok(out.into_iter().collect())
}

#[tauri::command]
async fn read_session_stderr(
    app: AppHandle,
    session_id: String,
    max_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    use std::collections::VecDeque;

    let dir = session_dir(&app, &session_id)?;
    let path = dir.join("stderr.log");
    let file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = VecDeque::new();
    let mut lines = BufReader::new(file).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(max) = max_lines {
            while out.len() >= max {
                out.pop_front();
            }
        }
        out.push_back(line);
    }
    Ok(out.into_iter().collect())
}

#[tauri::command]
async fn read_conclusion(app: AppHandle, session_id: String) -> Result<String, String> {
    let dir = session_dir(&app, &session_id)?;
    let path = dir.join("conclusion.md");
    tokio::fs::read_to_string(path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_session(app: AppHandle, session_id: String, title: String) -> Result<(), String> {
    let dir = session_dir(&app, &session_id)?;
    let meta_path = dir.join("meta.json");
    let Some(mut meta) = read_meta(&meta_path).await else {
        return Err("meta.json not found".to_string());
    };
    meta.title = title;
    write_meta(&meta_path, &meta).await
}

#[tauri::command]
async fn touch_session(app: AppHandle, session_id: String) -> Result<SessionMeta, String> {
    let dir = session_dir(&app, &session_id)?;
    let meta_path = dir.join("meta.json");
    let Some(mut meta) = read_meta(&meta_path).await else {
        return Err("meta.json not found".to_string());
    };
    meta.last_used_at_ms = now_ms();
    write_meta(&meta_path, &meta).await?;
    Ok(meta)
}

#[tauri::command]
async fn delete_session(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Best-effort stop if it's still running.
    let _ = stop_run(state, session_id.clone()).await;

    let dir = session_dir(&app, &session_id)?;
    tokio::fs::remove_dir_all(dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<Settings, String> {
    Ok(read_settings(&app).await)
}

#[tauri::command]
async fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    write_settings(&app, &settings).await?;
    Ok(settings)
}

#[tauri::command]
async fn detect_codex_paths_cmd(app: AppHandle) -> Result<Vec<String>, String> {
    let settings = read_settings(&app).await;
    let mut out = Vec::new();

    if let Some(path) = settings.codex_path {
        let path = path.trim();
        if !path.is_empty() {
            out.push(path.to_string());
        }
    }

    for p in detect_codex_paths() {
        out.push(p.display().to_string());
    }

    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_run,
            continue_run,
            stop_run,
            list_sessions,
            read_session_events,
            read_session_stderr,
            read_conclusion,
            rename_session,
            touch_session,
            delete_session,
            get_settings,
            save_settings,
            detect_codex_paths_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
