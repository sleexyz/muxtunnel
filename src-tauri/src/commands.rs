use crate::claude_sessions;
use crate::pty_manager::{self, PtyMessage};
use crate::resolver;
use crate::session_order;
use crate::settings;
use crate::tmux;
use crate::AppState;
use tauri::ipc::Channel;
use tauri::State;

/// GET /api/sessions — list all sessions with dimensions and Claude metadata
#[tauri::command]
pub async fn sessions_list(state: State<'_, AppState>) -> Result<Vec<tmux::TmuxSession>, String> {
    let _ = state;
    let mut sessions = tmux::list_sessions().await;

    // Fetch all dimensions in parallel
    let dim_futures: Vec<_> = sessions
        .iter()
        .map(|s| tmux::get_session_dimensions(&s.name))
        .collect();

    let dimensions = futures::future::join_all(dim_futures).await;
    for (session, dim) in sessions.iter_mut().zip(dimensions) {
        session.dimensions = dim;
    }

    // Enrich panes with Claude session info in parallel
    let mut pane_futures = Vec::new();
    let mut pane_indices = Vec::new(); // (session_idx, window_idx, pane_idx)

    for (si, session) in sessions.iter().enumerate() {
        for (wi, window) in session.windows.iter().enumerate() {
            for (pi, pane) in window.panes.iter().enumerate() {
                if pane.process == "claude" {
                    let target = pane.target.clone();
                    pane_futures.push(async move {
                        let cwd = tmux::get_pane_cwd(&target).await;
                        if let Some(cwd) = cwd {
                            let mut claude_session = claude_sessions::get_active_session(&cwd);
                            if claude_session.is_some() {
                                if tmux::is_pane_processing(&target).await {
                                    claude_session.as_mut().unwrap().status =
                                        "thinking".to_string();
                                }
                            }
                            claude_session
                        } else {
                            None
                        }
                    });
                    pane_indices.push((si, wi, pi));
                }
            }
        }
    }

    let claude_results = futures::future::join_all(pane_futures).await;
    for ((si, wi, pi), claude_session) in pane_indices.into_iter().zip(claude_results) {
        if let Some(cs) = claude_session {
            sessions[si].windows[wi].panes[pi].claude_session = Some(cs);
        }
    }

    Ok(sessions)
}

/// POST /api/sessions — create a new session
#[tauri::command]
pub async fn sessions_create(name: String, cwd: String) -> Result<(), String> {
    tmux::create_session(&name, &cwd).await?;
    resolver::record_selection(&cwd);
    Ok(())
}

/// DELETE /api/sessions/:name
#[tauri::command]
pub async fn sessions_delete(name: String) -> Result<(), String> {
    tmux::kill_session(&name).await
}

/// DELETE /api/panes/:target
#[tauri::command]
pub async fn panes_delete(target: String) -> Result<(), String> {
    tmux::kill_pane(&target).await
}

/// POST /api/panes/:target/input
#[tauri::command]
pub async fn panes_input(target: String, text: String) -> Result<(), String> {
    tmux::send_keys_literal(&target, &text).await
}

/// POST /api/panes/:target/interrupt
#[tauri::command]
pub async fn panes_interrupt(target: String) -> Result<(), String> {
    tmux::send_interrupt(&target).await
}

/// GET /api/projects
#[tauri::command]
pub async fn projects_list(query: Option<String>) -> Result<Vec<resolver::ProjectResult>, String> {
    let q = query.unwrap_or_default();
    Ok(resolver::resolve(&q).await)
}

/// GET /api/projects/resolve/:name
#[tauri::command]
pub async fn projects_resolve(
    name: String,
) -> Result<resolver::ProjectResult, String> {
    resolver::resolve_one(&name)
        .await
        .ok_or_else(|| "No match".to_string())
}

/// POST /api/claude-sessions/:id/viewed
#[tauri::command]
pub fn claude_mark_viewed(id: String) -> Result<(), String> {
    claude_sessions::mark_session_viewed(&id);
    Ok(())
}

/// GET /api/session-order
#[tauri::command]
pub fn session_order_get() -> Vec<String> {
    session_order::get()
}

/// PUT /api/session-order
#[tauri::command]
pub fn session_order_save(order: Vec<String>) -> Result<(), String> {
    session_order::save(order);
    Ok(())
}

/// GET /api/settings
#[tauri::command]
pub fn settings_get() -> settings::SettingsResponse {
    settings::get_settings()
}

/// PTY connect — stream output via Tauri Channel
#[tauri::command]
pub async fn pty_connect(
    target: String,
    cols: u16,
    rows: u16,
    on_data: Channel<PtyMessage>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    pty_manager::connect(target, cols, rows, on_data, state.pty_sessions.clone()).await
}

/// Send input/resize to an active PTY session
#[tauri::command]
pub async fn pty_send(
    target: String,
    msg: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.pty_sessions.lock().await;
    let handle = sessions
        .get(&target)
        .ok_or_else(|| format!("No PTY session for target: {}", target))?;

    if let Some(msg_type) = msg.get("type").and_then(|v| v.as_str()) {
        match msg_type {
            "resize" => {
                let cols = msg
                    .get("cols")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(80) as u16;
                let rows = msg
                    .get("rows")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(24) as u16;
                handle.resize(cols, rows).await?;
            }
            "keys" => {
                if let Some(keys) = msg.get("keys").and_then(|v| v.as_str()) {
                    handle.write(keys.as_bytes()).await?;
                }
            }
            _ => {
                // Unknown message type — try to write as raw
                if let Some(s) = msg.as_str() {
                    handle.write(s.as_bytes()).await?;
                }
            }
        }
    } else {
        // Raw input
        let raw = serde_json::to_string(&msg).unwrap_or_default();
        handle.write(raw.as_bytes()).await?;
    }

    Ok(())
}

/// Close a PTY session
#[tauri::command]
pub async fn pty_close(target: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut sessions = state.pty_sessions.lock().await;
    if let Some(handle) = sessions.remove(&target) {
        handle.close();
    }
    Ok(())
}

/// Serve background image bytes
#[tauri::command]
pub fn asset_background() -> Result<Vec<u8>, String> {
    let path = settings::get_background_image_path()
        .ok_or_else(|| "No local background image configured".to_string())?;
    std::fs::read(&path).map_err(|e| format!("Failed to read background image: {}", e))
}
