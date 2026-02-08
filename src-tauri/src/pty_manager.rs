use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

/// Tracks all active PTY sessions, keyed by pane target string.
pub type PtySessionMap = HashMap<String, PtyHandle>;

/// Handle to an active PTY session.
pub struct PtyHandle {
    /// Writer for sending input to PTY
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Master PTY for resize operations
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Abort handle for the reader task
    abort: tokio::task::AbortHandle,
}

impl PtyHandle {
    pub async fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().await;
        writer
            .write_all(data)
            .map_err(|e| format!("PTY write failed: {}", e))?;
        writer
            .flush()
            .map_err(|e| format!("PTY flush failed: {}", e))?;
        Ok(())
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock().await;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY resize failed: {}", e))
    }

    pub fn close(&self) {
        self.abort.abort();
    }
}

/// Message types sent over the Tauri Channel to frontend
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum PtyMessage {
    /// Initial pane info
    #[serde(rename = "pane-info")]
    PaneInfo { pane: super::tmux::TmuxPane },
    /// Binary PTY data encoded as array of bytes
    #[serde(rename = "data")]
    Data { data: Vec<u8> },
    /// PTY process exited
    #[serde(rename = "exit")]
    Exit { code: Option<i32> },
    /// Error
    #[serde(rename = "error")]
    Error { message: String },
}

/// Connect to a tmux pane via PTY and stream output through a Tauri Channel.
pub async fn connect(
    target: String,
    cols: u16,
    rows: u16,
    channel: Channel<PtyMessage>,
    sessions: Arc<Mutex<PtySessionMap>>,
) -> Result<(), String> {
    // Verify pane exists and get info
    let pane_info = super::tmux::get_pane_info(&target)
        .await
        .ok_or_else(|| format!("Pane not found: {}", target))?;

    // Send initial pane info
    channel
        .send(PtyMessage::PaneInfo { pane: pane_info })
        .map_err(|e| format!("Failed to send pane info: {}", e))?;

    // Create PTY
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build command: tmux attach-session -t TARGET
    let mut cmd = CommandBuilder::new("tmux");
    cmd.args(["attach-session", "-t", &target]);

    // Set environment
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Ok(lang) = std::env::var("LANG") {
        cmd.env("LANG", lang);
    } else {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if let Ok(lc) = std::env::var("LC_ALL") {
        cmd.env("LC_ALL", lc);
    } else {
        cmd.env("LC_ALL", "en_US.UTF-8");
    }

    // Spawn child process
    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn tmux attach: {}", e))?;

    // Drop slave immediately — we communicate through master
    drop(pair.slave);

    let writer: Box<dyn Write + Send> = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = Arc::new(Mutex::new(writer));
    let master: Box<dyn portable_pty::MasterPty + Send> = pair.master;
    let master = Arc::new(Mutex::new(master));

    // Spawn reader task
    let channel_clone = channel.clone();
    let target_clone = target.clone();
    let sessions_clone = sessions.clone();

    let reader_task = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF
                    let _ = channel_clone.send(PtyMessage::Exit { code: Some(0) });
                    break;
                }
                Ok(n) => {
                    if channel_clone
                        .send(PtyMessage::Data {
                            data: buf[..n].to_vec(),
                        })
                        .is_err()
                    {
                        // Channel closed (frontend disconnected)
                        break;
                    }
                }
                Err(e) => {
                    let _ = channel_clone.send(PtyMessage::Error {
                        message: format!("PTY read error: {}", e),
                    });
                    break;
                }
            }
        }

        // Cleanup
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async {
            let mut map = sessions_clone.lock().await;
            map.remove(&target_clone);
        });
    });

    let handle = PtyHandle {
        writer,
        master,
        abort: reader_task.abort_handle(),
    };

    // Store in session map
    {
        let mut map = sessions.lock().await;
        // Close existing session for this target if any
        if let Some(old) = map.remove(&target) {
            old.close();
        }
        map.insert(target, handle);
    }

    Ok(())
}
