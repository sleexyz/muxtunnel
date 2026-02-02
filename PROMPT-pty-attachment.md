# Session: pty-attachment

Replace capture-pane polling with proper PTY attachment for correct terminal rendering.

## Problem

Current approach uses `tmux capture-pane` polling:
- Captures already-rendered content at whatever dimensions it was written
- Scrollback doesn't reflow when pane is resized
- Causes horizontal overflow when viewer is narrower than original pane

## Solution

Use PTY attachment like webmux does:
1. Create a PTY with dimensions matching the web viewer
2. Run `tmux attach-session -t TARGET` in that PTY
3. tmux sees a real terminal client → resizes session → formats output correctly
4. Stream PTY output to WebSocket, forward input to PTY

## Outcome

A working terminal view where:
- Content renders correctly at the viewer's dimensions
- No horizontal overflow
- Bidirectional I/O (keystrokes work)
- Colors and formatting preserved

## Reference

**webmux implementation:** `downloads/webmux/backend-rust/src/websocket/mod.rs`
- Uses `portable_pty` crate (Rust)
- Creates PTY with `PtySize { rows, cols }`
- Runs `tmux attach-session -t SESSION_NAME`
- Streams PTY reader to WebSocket

**Our prior art:** `~/wbsm/Agent-client/terminal-server`
- Uses `@replit/ruspty` for Node.js PTY
- Already has WebSocket + xterm.js pattern

## Tasks

### Phase 1: Add PTY Library
- [ ] Add `node-pty` or `@replit/ruspty` to package.json
- [ ] Verify it builds (native module)
- [ ] Create `src/pty.ts` wrapper module

### Phase 2: Refactor Server for PTY Sessions
- [ ] Create `PtySession` class that:
  - Spawns PTY with `tmux attach-session -t TARGET`
  - Sets PTY size from client dimensions
  - Provides read stream and write method
- [ ] Update WebSocket handler to:
  - Create PtySession on connect (with client's cols/rows)
  - Pipe PTY output to WebSocket (binary or text)
  - Forward WebSocket input to PTY stdin
  - Handle resize messages → PTY resize
- [ ] Remove capture-pane polling logic

### Phase 3: Update Client
- [ ] Remove capture-pane specific handling
- [ ] Send raw binary/text to terminal.write()
- [ ] Ensure resize messages still work
- [ ] Test keystroke forwarding

### Phase 4: Handle Multiple Panes
- [ ] One PTY per connected pane (not session)
- [ ] Use `tmux select-pane -t TARGET` before attach? Or attach to specific pane
- [ ] Clean up PTY on WebSocket close

### Phase 5: Validation
- [ ] Test with real Claude Code session
- [ ] Verify no horizontal overflow
- [ ] Verify keystrokes work (y, n, Enter)
- [ ] Verify colors render correctly
- [ ] Test switching between panes

## Predictions

- [ ] node-pty will require native compilation but should work on macOS [guess]
- [ ] tmux attach-session will resize the session to match PTY dimensions [FACTS#research-spike-01]
- [ ] Binary WebSocket messages will be more efficient than JSON wrapping [guess]
- [ ] We may need to handle tmux prefix key (Ctrl-B) specially [guess]
- [ ] PTY cleanup on disconnect is important to avoid zombie processes [guess]

## Assumptions

- Node.js can spawn native PTY (node-pty or ruspty works)
- tmux attach-session can target specific panes (not just sessions)
- xterm.js can handle raw PTY output directly

## Out of Scope

- Attention detection changes (keep existing pattern matching)
- Session list UI changes
- Mobile optimizations
- Multiple simultaneous pane views

## Technical Notes

**tmux attach to specific pane:**
```bash
tmux attach-session -t "session:window.pane"
# e.g., tmux attach-session -t "muxtunnel:0.1"
```

**PTY size in node-pty:**
```typescript
const pty = spawn('tmux', ['attach-session', '-t', target], {
  cols: 80,
  rows: 24,
  env: { TERM: 'xterm-256color' }
});
pty.resize(cols, rows);  // on resize message
```

**WebSocket binary vs text:**
- PTY output is binary (raw terminal data with escape codes)
- Can send as binary WebSocket frames or base64 encode
- xterm.js can handle both

## Codebase Context

> Prefer retrieval-led reasoning over pretraining-led reasoning.

**Facts:** research-spike-01:tmux attach-session resizes session to client dimensions|terminal-server:prior art at ~/wbsm/Agent-client/terminal-server uses @replit/ruspty|webmux:reference implementation at downloads/webmux uses portable_pty for PTY attachment

**Heuristics:** fork-then-adapt:copy working PTY pattern from terminal-server|poll-then-push:we tried polling, now doing proper push via PTY
