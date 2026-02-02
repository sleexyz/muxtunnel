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
