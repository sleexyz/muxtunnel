# Facts

Codebase-specific truths about MuxTunnel.

## research-spike-01
**tmux programmatic interface**
- `tmux capture-pane -p -t TARGET` returns rendered screen content (tmux already did terminal emulation)
- `tmux capture-pane -e -p` includes ANSI escape codes for styling
- `tmux send-keys -t TARGET "text" Enter` sends keystrokes; use `-l` for literal text
- `tmux list-sessions`, `list-windows`, `list-panes` for discovery
- No content-change hook exists; must poll or use control mode (`-CC`)

## terminal-server
**Prior art at ~/wbsm/Agent-client/terminal-server**
- WebSocket + HTTP server pattern using `ws` library
- xterm.js client with FitAddon (auto-resize) and WebglAddon (performance)
- Uses @replit/ruspty for PTY - we replace this with tmux integration
- JSON control messages: `{ type: "resize", cols, rows }`
- Binary WebSocket data for terminal I/O

## claude-hooks
**Claude Code integration points**
- Hooks configured in `.claude/settings.json`
- `Notification` hook fires when Claude sends alerts
- `Stop` hook fires when Claude finishes responding
- Hooks receive JSON on stdin with session_id, transcript_path, message
- Session transcripts at `~/.claude/projects/.../session.jsonl`

## capture-pane-limitations
**Why capture-pane causes rendering issues**
- capture-pane captures already-rendered content at whatever dimensions it was written
- Terminal scrollback doesn't reflow when pane is resized
- If content was rendered at 200 cols and viewer is 150 cols, content overflows
- This is a fundamental terminal limitation, not a bug

## pty-attachment
**The correct approach for web terminal viewers**
- webmux (downloads/webmux) uses PTY attachment via portable_pty
- Create PTY with viewer's dimensions → run `tmux attach-session -t TARGET`
- tmux sees a real terminal client → resizes session → formats output correctly
- Bidirectional: PTY output streams to WebSocket, input forwards to PTY stdin
- This is how proper web terminals (ttyd, gotty, wetty) work
