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
    events_path: String,
    stderr_path: String,
    conclusion_path: String,
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

async fn read_meta(path: &Path) -> Option<SessionMeta> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn write_meta(path: &Path, meta: &SessionMeta) -> Result<(), String> {
    tokio::fs::write(path, serde_json::to_vec_pretty(meta).unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
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

    while let Ok(Some(line)) = lines.next_line().await {
        let _ = file.write_all(line.as_bytes()).await;
        let _ = file.write_all(b"\n").await;

        let json = if emit_json {
            serde_json::from_str::<serde_json::Value>(&line).ok()
        } else {
            None
        };

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
    prompt: String,
    cwd: Option<String>,
) -> Result<SessionMeta, String> {
    let session_id = Uuid::new_v4().to_string();
    let created_at_ms = now_ms();

    let dir = session_dir(&app, &session_id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;

    let events_path = dir.join("events.jsonl");
    let stderr_path = dir.join("stderr.log");
    let conclusion_path = dir.join("conclusion.md");

    let mut cmd = Command::new("codex");
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

    cmd.arg(prompt.clone())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_run,
            stop_run,
            list_sessions,
            read_session_events,
            read_conclusion,
            rename_session,
            delete_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
