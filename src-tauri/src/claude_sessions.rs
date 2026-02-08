use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

static STATE: once_cell::sync::Lazy<Mutex<ClaudeState>> =
    once_cell::sync::Lazy::new(|| Mutex::new(ClaudeState::default()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    pub session_id: String,
    pub summary: String,
    pub status: String, // "thinking" | "done" | "idle"
    pub notified: bool,
}

#[derive(Default)]
struct ClaudeState {
    /// notification state per session: (notified, viewed_at)
    notification: HashMap<String, (bool, Option<SystemTime>)>,
    /// previous status for change detection
    previous_status: HashMap<String, String>,
}

fn claude_projects_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
}

/// Read the status of a Claude session from its JSONL file
fn get_session_status(jsonl_path: &Path) -> &'static str {
    let meta = match fs::metadata(jsonl_path) {
        Ok(m) => m,
        Err(_) => return "idle",
    };

    let file_size = meta.len();
    if file_size == 0 {
        return "idle";
    }

    // Read last 10KB of file
    let read_size = file_size.min(10000) as usize;
    let mut file = match fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(_) => return "idle",
    };

    if file_size > read_size as u64 {
        let _ = file.seek(SeekFrom::Start(file_size - read_size as u64));
    }

    let mut buffer = vec![0u8; read_size];
    let bytes_read = match file.read(&mut buffer) {
        Ok(n) => n,
        Err(_) => return "idle",
    };
    buffer.truncate(bytes_read);

    let content = String::from_utf8_lossy(&buffer);
    let lines: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return "idle";
    }

    let last_line = lines[lines.len() - 1];
    let msg: serde_json::Value = match serde_json::from_str(last_line) {
        Ok(v) => v,
        Err(_) => return "idle",
    };

    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_millis())
        .unwrap_or(u128::MAX);

    match msg_type {
        "summary" => "done",
        "user" => {
            if mtime < 60_000 {
                "thinking"
            } else {
                "done"
            }
        }
        "assistant" => {
            if mtime < 3_000 {
                "thinking"
            } else {
                "done"
            }
        }
        _ => "idle",
    }
}

/// Get all Claude sessions for a project path
pub fn get_sessions_for_project(project_path: &str) -> Vec<ClaudeSession> {
    let project_slug = project_path.replace('/', "-");
    let project_dir = claude_projects_dir().join(&project_slug);

    if !project_dir.exists() {
        return vec![];
    }

    // Try sessions-index.json first
    let index_path = project_dir.join("sessions-index.json");

    #[derive(Deserialize)]
    struct IndexEntry {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "fullPath")]
        full_path: String,
        summary: Option<String>,
        #[serde(rename = "projectPath")]
        project_path: Option<String>,
    }

    #[derive(Deserialize)]
    struct SessionsIndex {
        entries: Vec<IndexEntry>,
    }

    let entries: Vec<(String, PathBuf, String)> = if index_path.exists() {
        match fs::read_to_string(&index_path).ok().and_then(|s| {
            serde_json::from_str::<SessionsIndex>(&s).ok()
        }) {
            Some(index) => index
                .entries
                .into_iter()
                .filter(|e| {
                    e.project_path
                        .as_deref()
                        .map(|p| p == project_path)
                        .unwrap_or(true)
                })
                .map(|e| {
                    (
                        e.session_id,
                        PathBuf::from(e.full_path),
                        e.summary.unwrap_or_default(),
                    )
                })
                .collect(),
            None => vec![],
        }
    } else {
        // Fallback: scan .jsonl files directly
        match fs::read_dir(&project_dir) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|ext| ext == "jsonl")
                        .unwrap_or(false)
                })
                .map(|e| {
                    let path = e.path();
                    let session_id = path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    (session_id, path, String::new())
                })
                .collect(),
            Err(_) => vec![],
        }
    };

    let mut state = STATE.lock().unwrap();
    let mut results: Vec<ClaudeSession> = entries
        .into_iter()
        .map(|(session_id, full_path, summary)| {
            check_and_notify(&mut state, &session_id, &full_path);
            let status = get_session_status(&full_path).to_string();
            let (notified, _) = state
                .notification
                .get(&session_id)
                .copied()
                .unwrap_or((false, None));

            ClaudeSession {
                session_id,
                summary,
                status,
                notified,
            }
        })
        .collect();

    // Sort by most recent first (we can't easily sort by modified time here,
    // but the index entries are already in a reasonable order)
    results.reverse();
    results
}

/// Get the most recent active Claude session for a project
pub fn get_active_session(project_path: &str) -> Option<ClaudeSession> {
    let sessions = get_sessions_for_project(project_path);
    sessions.into_iter().next()
}

/// Mark a session as viewed (clears notification)
pub fn mark_session_viewed(session_id: &str) {
    let mut state = STATE.lock().unwrap();
    state
        .notification
        .insert(session_id.to_string(), (false, Some(SystemTime::now())));
}

/// Check if a session should trigger a notification
fn check_and_notify(state: &mut ClaudeState, session_id: &str, full_path: &Path) {
    let status = get_session_status(full_path).to_string();
    let prev_status = state.previous_status.get(session_id).cloned();
    let (mut notified, mut viewed_at) = state
        .notification
        .get(session_id)
        .copied()
        .unwrap_or((false, None));

    // Reset viewedAt when a new turn starts
    if prev_status.as_deref() == Some("done") && status != "done" {
        viewed_at = None;
    }

    // Detect thinking → done transition
    if prev_status.as_deref() == Some("thinking") && status == "done" {
        log::info!("Claude session {} completed", session_id);
        notified = true;
    }

    // Also notify if done and hasn't been notified yet (and not viewed)
    if status == "done" && !notified && viewed_at.is_none() {
        log::info!("Claude session {} needs attention (done)", session_id);
        notified = true;
    }

    state
        .notification
        .insert(session_id.to_string(), (notified, viewed_at));
    state
        .previous_status
        .insert(session_id.to_string(), status);
}

/// Start watching Claude session files for changes
pub async fn start_watching(app_handle: tauri::AppHandle) {
    let projects_dir = claude_projects_dir();
    if !projects_dir.exists() {
        log::info!("Claude projects directory not found, skipping session watching");
        return;
    }

    log::info!("Watching Claude sessions at: {:?}", projects_dir);

    // Use notify crate for file watching
    use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("Failed to create file watcher: {}", e);
            return;
        }
    };

    if let Err(e) = watcher.watch(&projects_dir, RecursiveMode::Recursive) {
        log::warn!("Failed to watch Claude projects dir: {}", e);
        return;
    }

    // Keep watcher alive by moving it into the task
    let _watcher = watcher;
    let _app_handle = app_handle;

    // Process file change events
    tokio::task::spawn_blocking(move || {
        for result in rx {
            if let Ok(event) = result {
                for path in &event.paths {
                    if let Some(ext) = path.extension() {
                        if ext == "jsonl" {
                            let session_id = path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            let mut state = STATE.lock().unwrap();
                            check_and_notify(&mut state, &session_id, path);
                        }
                    }
                }
            }
        }
    });
}
