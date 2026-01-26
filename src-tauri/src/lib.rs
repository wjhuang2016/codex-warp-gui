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
    process::Command,
    sync::{oneshot, Mutex},
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
    serde_json::from_slice(&bytes).ok()
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
        if json.get("type").and_then(|v| v.as_str()) != Some("thread.started") {
            continue;
        }
        let thread_id = json.get("thread_id").and_then(|v| v.as_str())?;
        return Some(thread_id.to_string());
    }

    None
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
        tokio::fs::write(dir.join("conclusion.md"), text)
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

    let mut cmd = Command::new(codex);
    cmd.arg("exec")
        .arg("--json")
        .arg("--full-auto")
        .arg("--skip-git-repo-check")
        .arg("--output-last-message")
        .arg(&conclusion_path);

    if let Some(ref dir) = cwd {
        cmd.arg("--cd").arg(dir);
        cmd.current_dir(dir);
    }

    cmd.arg("--")
        .arg(prompt.clone())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let error = format!("Failed to start codex: {e}");
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
    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

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

    let app_for_stdout = app.clone();
    let session_id_for_stdout = session_id.clone();
    let events_path_for_stdout = events_path.clone();
    tokio::spawn(async move {
        stream_lines(
            app_for_stdout,
            session_id_for_stdout,
            "stdout".to_string(),
            stdout,
            events_path_for_stdout,
            true,
        )
        .await;
    });

    let app_for_stderr = app.clone();
    let session_id_for_stderr = session_id.clone();
    tokio::spawn(async move {
        stream_lines(
            app_for_stderr,
            session_id_for_stderr,
            "stderr".to_string(),
            stderr,
            stderr_path,
            false,
        )
        .await;
    });

    let app_for_wait = app.clone();
    let session_id_for_wait = session_id.clone();
    let runs = state.runs.clone();
    tokio::spawn(async move {
        let session_id = session_id_for_wait;
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            _ = cancel_rx => {
                let _ = child.kill().await;
                child.wait().await.ok()
            }
        };

        let (exit_code, success) = match status {
            Some(s) => (s.code(), s.success()),
            None => (None, false),
        };

        {
            let mut locked = runs.lock().await;
            locked.remove(&session_id);
        }

        if let Ok(dir) = session_dir(&app_for_wait, &session_id) {
            let meta_path = dir.join("meta.json");
            if let Some(mut meta) = read_meta(&meta_path).await {
                meta.status = if success {
                    SessionStatus::Done
                } else {
                    SessionStatus::Error
                };
                let _ = write_meta(&meta_path, &meta).await;
            }
            let _ = update_conclusion_from_events(&dir).await;
        }

        let payload = RunFinished {
            session_id,
            ts_ms: now_ms(),
            exit_code,
            success,
        };
        let _ = app_for_wait.emit("codex_run_finished", payload);
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

    let mut cmd = Command::new(codex);
    if let Some(ref codex_session_id) = meta.codex_session_id {
        cmd.arg("exec")
            .arg("resume")
            .arg("--json")
            .arg("--full-auto")
            .arg("--skip-git-repo-check")
            .arg(codex_session_id)
            .arg("--")
            .arg(&prompt_text);
    } else {
        cmd.arg("exec")
            .arg("--json")
            .arg("--full-auto")
            .arg("--skip-git-repo-check")
            .arg("--output-last-message")
            .arg(&conclusion_path);

        if let Some(ref dir) = cwd {
            cmd.arg("--cd").arg(dir);
            cmd.current_dir(dir);
        }

        cmd.arg("--").arg(&prompt_text);
    }

    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let error = format!("Failed to start codex: {e}");
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

            meta.status = SessionStatus::Error;
            let _ = write_meta(&meta_path, &meta).await;

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

    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

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

    let app_for_stdout = app.clone();
    let session_id_for_stdout = session_id.clone();
    let events_path_for_stdout = events_path.clone();
    tokio::spawn(async move {
        stream_lines(
            app_for_stdout,
            session_id_for_stdout,
            "stdout".to_string(),
            stdout,
            events_path_for_stdout,
            true,
        )
        .await;
    });

    let app_for_stderr = app.clone();
    let session_id_for_stderr = session_id.clone();
    tokio::spawn(async move {
        stream_lines(
            app_for_stderr,
            session_id_for_stderr,
            "stderr".to_string(),
            stderr,
            stderr_path,
            false,
        )
        .await;
    });

    let app_for_wait = app.clone();
    let session_id_for_wait = session_id.clone();
    let runs = state.runs.clone();
    tokio::spawn(async move {
        let session_id = session_id_for_wait;
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            _ = cancel_rx => {
                let _ = child.kill().await;
                child.wait().await.ok()
            }
        };

        let (exit_code, success) = match status {
            Some(s) => (s.code(), s.success()),
            None => (None, false),
        };

        {
            let mut locked = runs.lock().await;
            locked.remove(&session_id);
        }

        if let Ok(dir) = session_dir(&app_for_wait, &session_id) {
            let meta_path = dir.join("meta.json");
            if let Some(mut meta) = read_meta(&meta_path).await {
                meta.status = if success {
                    SessionStatus::Done
                } else {
                    SessionStatus::Error
                };
                let _ = write_meta(&meta_path, &meta).await;
            }
            let _ = update_conclusion_from_events(&dir).await;
        }

        let payload = RunFinished {
            session_id,
            ts_ms: now_ms(),
            exit_code,
            success,
        };
        let _ = app_for_wait.emit("codex_run_finished", payload);
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

    sessions.sort_by_key(|s| Reverse(s.created_at_ms));
    Ok(sessions)
}

#[tauri::command]
async fn read_session_events(
    app: AppHandle,
    session_id: String,
    max_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let dir = session_dir(&app, &session_id)?;
    let path = dir.join("events.jsonl");
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    let mut lines = BufReader::new(file).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        out.push(line);
        if max_lines.is_some_and(|max| out.len() >= max) {
            break;
        }
    }
    Ok(out)
}

#[tauri::command]
async fn read_session_stderr(
    app: AppHandle,
    session_id: String,
    max_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let dir = session_dir(&app, &session_id)?;
    let path = dir.join("stderr.log");
    let file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    let mut lines = BufReader::new(file).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        out.push(line);
        if max_lines.is_some_and(|max| out.len() >= max) {
            break;
        }
    }
    Ok(out)
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
            delete_session,
            get_settings,
            save_settings,
            detect_codex_paths_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
