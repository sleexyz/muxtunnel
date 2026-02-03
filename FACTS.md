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
- **Critical:** tmux client and server versions must match (see HEURISTICS#tmux-version-mismatch)
- **For pane cropping:** PTY must match session dimensions exactly, or tmux resizes and invalidates pane geometry

## pane-geometry
**tmux pane geometry for cropping**
- `tmux list-panes -F '#{pane_id}:#{pane_left}:#{pane_top}:#{pane_width}:#{pane_height}'`
- Coordinates are 0-indexed, in character units (not pixels)
- Border separators are 1 character wide between panes
- No push mechanism for geometry changes; must poll

## xterm-cell-dimensions
**Getting character dimensions from xterm.js**
- Internal API: `terminal._core._renderService.dimensions.css.cell.{width,height}`
- Returns pixel dimensions per character cell
- Used by FitAddon internally; same approach works for cropping
- Must wait for terminal to render before dimensions are available

## css-pane-cropping
**How CSS cropping works for pane isolation**
- Terminal renders at full session size (e.g., 181×61)
- `overflow: hidden` on crop-container clips to pane dimensions
- `transform: translate(-left, -top)` shifts terminal to show correct region
- Pane switching within same session is CSS-only (instant, no reconnect)
- Session switching requires new PTY connection

## tmux-pane-coordinates
**tmux pane_left/pane_top already account for borders**
- Vertical split: left pane cols 0-88, border at 89, right pane starts at 90
- `pane_left=90` means content starts at column 90 (after border)
- No additional border offset needed when cropping
- Session dimensions via: `tmux display-message -t SESSION -p "#{window_width}:#{window_height}"`

## xterm-mouse-with-css-crop
**Mouse coordinates work automatically with CSS cropping**
- xterm.js canvas is full session size
- CSS transform positions it so pane region is visible
- Clicks hit the actual canvas at session-relative coordinates
- xterm.js reports correct coordinates—no translation needed!
- SGR mouse format: `\x1b[<code;col;row;M` (press) or `\x1b[<code;col;row;m` (release)
- DEFAULT mouse format: `\x1b[M<byte><byte><byte>` (code+32, col+32, row+32)
