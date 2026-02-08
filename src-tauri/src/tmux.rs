use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPane {
    pub session_name: String,
    pub window_index: u32,
    pub window_name: String,
    pub pane_index: u32,
    pub pane_id: String,
    pub target: String,
    pub active: bool,
    pub cols: u32,
    pub rows: u32,
    pub left: u32,
    pub top: u32,
    pub pid: u32,
    pub process: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session: Option<super::claude_sessions::ClaudeSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWindow {
    pub index: u32,
    pub name: String,
    pub panes: Vec<TmuxPane>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub name: String,
    pub windows: Vec<TmuxWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<SessionDimensions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDimensions {
    pub width: u32,
    pub height: u32,
}

/// Extract clean command name from ps output (basename of path)
fn extract_cmd_name(ps_output: &str) -> &str {
    let first_word = ps_output.split_whitespace().next().unwrap_or(ps_output);
    match first_word.rfind('/') {
        Some(pos) => &first_word[pos + 1..],
        None => first_word,
    }
}

/// Shell/wrapper commands to skip when walking the process tree
const WRAPPERS: &[&str] = &[
    "zsh", "bash", "sh", "fish", "tcsh", "csh", "-zsh", "-bash", "-sh", "npm", "npx", "node",
];

/// Fetch the entire process table in a single `ps` call.
async fn get_process_table() -> HashMap<u32, (u32, String)> {
    let output = Command::new("ps")
        .args(["-eo", "pid=,ppid=,comm="])
        .output()
        .await;

    let mut table = HashMap::new();
    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Parse: PID PPID COMMAND
            let parts: Vec<&str> = trimmed.splitn(3, char::is_whitespace).collect();
            if parts.len() >= 3 {
                if let (Ok(pid), Ok(ppid)) = (parts[0].trim().parse::<u32>(), parts[1].trim().parse::<u32>()) {
                    table.insert(pid, (ppid, parts[2].trim().to_string()));
                }
            }
        }
    }
    table
}

/// Walk the process tree to find the real command (skip shells and wrappers)
fn get_effective_process_from_table(
    pid: u32,
    current_command: &str,
    table: &HashMap<u32, (u32, String)>,
) -> String {
    if !WRAPPERS.contains(&current_command) {
        return current_command.to_string();
    }

    let mut current_pid = pid;
    for _ in 0..5 {
        // Find children of current_pid
        let children: Vec<u32> = table
            .iter()
            .filter(|(_, (ppid, _))| *ppid == current_pid)
            .map(|(child_pid, _)| *child_pid)
            .collect();

        if children.is_empty() {
            if current_pid != pid {
                if let Some((_, comm)) = table.get(&current_pid) {
                    let cmd = extract_cmd_name(comm);
                    if !cmd.is_empty() {
                        return cmd.to_string();
                    }
                }
            }
            return current_command.to_string();
        }

        let child_pid = children[0];
        let child_info = match table.get(&child_pid) {
            Some(info) => info,
            None => return current_command.to_string(),
        };

        let cmd_name = extract_cmd_name(&child_info.1);
        if !WRAPPERS.contains(&cmd_name) {
            let prefixed = format!("-{}", cmd_name);
            if !WRAPPERS.contains(&prefixed.as_str()) {
                return cmd_name.to_string();
            }
        }

        current_pid = child_pid;
    }

    current_command.to_string()
}

/// Check if tmux server is running
pub async fn is_tmux_running() -> bool {
    Command::new("tmux")
        .args(["list-sessions"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// List all tmux sessions with full pane info (async, non-blocking)
pub async fn list_sessions() -> Vec<TmuxSession> {
    let format_str = "#{session_name}:#{window_index}:#{window_name}:#{pane_index}:#{pane_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_left}:#{pane_top}:#{pane_pid}:#{pane_current_command}:#{session_activity}:#{session_path}";

    let (tmux_result, process_table) = tokio::join!(
        Command::new("tmux")
            .args(["list-panes", "-a", "-F", format_str])
            .output(),
        get_process_table()
    );

    let tmux_output = match tmux_result {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return vec![],
    };

    let mut sessions: HashMap<String, TmuxSession> = HashMap::new();

    for line in tmux_output.lines() {
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.splitn(14, ':').collect();
        if parts.len() < 12 {
            continue;
        }

        let session_name = parts[0].to_string();
        let window_index: u32 = parts[1].parse().unwrap_or(0);
        let window_name = parts[2].to_string();
        let pane_index: u32 = parts[3].parse().unwrap_or(0);
        let pane_id = parts[4].to_string();
        let active = parts[5] == "1";
        let cols: u32 = parts[6].parse().unwrap_or(80);
        let rows: u32 = parts[7].parse().unwrap_or(24);
        let left: u32 = parts[8].parse().unwrap_or(0);
        let top: u32 = parts[9].parse().unwrap_or(0);
        let pid: u32 = parts[10].parse().unwrap_or(0);
        let current_command = parts[11];
        let session_activity: u64 = parts.get(12).and_then(|s| s.parse().ok()).unwrap_or(0);
        // session_path may contain colons, so rejoin everything after field 13
        let session_path = if parts.len() > 13 {
            Some(parts[13..].join(":"))
        } else {
            None
        };

        let process = get_effective_process_from_table(pid, current_command, &process_table);
        let target = format!("{}:{}.{}", session_name, window_index, pane_index);

        let pane = TmuxPane {
            session_name: session_name.clone(),
            window_index,
            window_name: window_name.clone(),
            pane_index,
            pane_id,
            target,
            active,
            cols,
            rows,
            left,
            top,
            pid,
            process,
            claude_session: None,
        };

        let session = sessions.entry(session_name.clone()).or_insert_with(|| TmuxSession {
            name: session_name,
            windows: vec![],
            dimensions: None,
            activity: if session_activity > 0 {
                Some(session_activity)
            } else {
                None
            },
            path: session_path.filter(|p| !p.is_empty()),
        });

        if let Some(window) = session.windows.iter_mut().find(|w| w.index == window_index) {
            window.panes.push(pane);
        } else {
            session.windows.push(TmuxWindow {
                index: window_index,
                name: window_name,
                panes: vec![pane],
            });
        }
    }

    // Sort sessions by name (stable order — HashMap iteration is non-deterministic)
    let mut result: Vec<TmuxSession> = sessions.into_values().collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    for session in &mut result {
        session.windows.sort_by_key(|w| w.index);
        for window in &mut session.windows {
            window.panes.sort_by_key(|p| p.pane_index);
        }
    }

    result
}

/// Get dimensions of a session's current window
pub async fn get_session_dimensions(session_name: &str) -> Option<SessionDimensions> {
    let output = Command::new("tmux")
        .args([
            "display-message",
            "-t",
            session_name,
            "-p",
            "#{window_width}:#{window_height}",
        ])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    let mut parts = trimmed.splitn(2, ':');
    let width: u32 = parts.next()?.parse().ok()?;
    let height: u32 = parts.next()?.parse().ok()?;
    Some(SessionDimensions { width, height })
}

/// Create a new tmux session (idempotent)
pub async fn create_session(name: &str, cwd: &str) -> Result<(), String> {
    // Check if session already exists
    let check = Command::new("tmux")
        .args(["has-session", "-t", name])
        .output()
        .await;

    if let Ok(o) = check {
        if o.status.success() {
            return Ok(()); // Already exists
        }
    }

    let output = Command::new("tmux")
        .args(["new-session", "-d", "-s", name, "-c", cwd])
        .output()
        .await
        .map_err(|e| format!("Failed to create session: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "tmux new-session failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Kill a tmux session
pub async fn kill_session(name: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["kill-session", "-t", name])
        .output()
        .await
        .map_err(|e| format!("Failed to kill session: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "tmux kill-session failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Kill a tmux pane
pub async fn kill_pane(target: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["kill-pane", "-t", target])
        .output()
        .await
        .map_err(|e| format!("Failed to kill pane: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "tmux kill-pane failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Send keys to a tmux pane (literal text + Enter)
pub async fn send_keys_literal(target: &str, text: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["send-keys", "-t", target, "-l", text])
        .output()
        .await
        .map_err(|e| format!("Failed to send keys: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "tmux send-keys failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Send Enter
    Command::new("tmux")
        .args(["send-keys", "-t", target, "Enter"])
        .output()
        .await
        .map_err(|e| format!("Failed to send Enter: {}", e))?;

    Ok(())
}

/// Send Ctrl+C to a tmux pane
pub async fn send_interrupt(target: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["send-keys", "-t", target, "C-c"])
        .output()
        .await
        .map_err(|e| format!("Failed to send interrupt: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "tmux send-keys C-c failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Get pane info for a specific target
pub async fn get_pane_info(target: &str) -> Option<TmuxPane> {
    let format_str = "#{session_name}:#{window_index}:#{window_name}:#{pane_index}:#{pane_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_left}:#{pane_top}:#{pane_pid}:#{pane_current_command}";

    let output = Command::new("tmux")
        .args(["display-message", "-t", target, "-p", format_str])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();
    let parts: Vec<&str> = line.splitn(12, ':').collect();
    if parts.len() < 12 {
        return None;
    }

    let pid: u32 = parts[10].parse().unwrap_or(0);
    // For single pane lookup, do a quick process table fetch
    let table = get_process_table().await;
    let process = get_effective_process_from_table(pid, parts[11], &table);

    Some(TmuxPane {
        session_name: parts[0].to_string(),
        window_index: parts[1].parse().unwrap_or(0),
        window_name: parts[2].to_string(),
        pane_index: parts[3].parse().unwrap_or(0),
        pane_id: parts[4].to_string(),
        target: target.to_string(),
        active: parts[5] == "1",
        cols: parts[6].parse().unwrap_or(80),
        rows: parts[7].parse().unwrap_or(24),
        left: parts[8].parse().unwrap_or(0),
        top: parts[9].parse().unwrap_or(0),
        pid,
        process,
        claude_session: None,
    })
}

/// Get pane's current working directory
pub async fn get_pane_cwd(target: &str) -> Option<String> {
    let output = Command::new("tmux")
        .args([
            "display-message",
            "-t",
            target,
            "-p",
            "#{pane_current_path}",
        ])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let cwd = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if cwd.is_empty() {
        None
    } else {
        Some(cwd)
    }
}

/// Capture last N lines of a pane with escape sequences
pub async fn capture_pane_with_escapes(target: &str, start_line: i32) -> Option<String> {
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-t",
            target,
            "-p",
            "-e",
            "-S",
            &start_line.to_string(),
        ])
        .output()
        .await
        .ok()?;

    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        None
    }
}

/// Check if a pane is showing Claude's orange thinking indicator
pub async fn is_pane_processing(target: &str) -> bool {
    let output = match capture_pane_with_escapes(target, -10).await {
        Some(o) => o,
        None => return false,
    };

    // Orange/salmon color range used by Claude Code thinking status
    // Pattern: \x1b[38;2;R;G;Bm where R=200-239, G=100-159, B=80-129
    let thinking_re = regex::Regex::new(
        r"\x1b\[38;2;(2[0-3][0-9]);(1[0-5][0-9]);([89][0-9]|1[0-2][0-9])m",
    )
    .unwrap();

    thinking_re.is_match(&output) && output.contains('\u{2026}') // ellipsis "…"
}
