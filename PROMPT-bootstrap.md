# Session: bootstrap

Bootstrap MuxTunnel by forking the terminal-server foundation and adapting it for tmux integration.

## Outcome

A working prototype that:
1. Lists all tmux sessions/panes via a web UI
2. Shows live pane content using xterm.js
3. Can send keystrokes to a selected pane
4. Detects "needs attention" state (basic pattern matching)

## Context

**Prior art to fork:** `/Users/slee2/wbsm/Agent-client/terminal-server`
- xterm.js client with FitAddon, WebglAddon
- WebSocket server pattern
- Vite + TypeScript build

**Key adaptation:** Replace ruspty PTY spawning with tmux capture-pane/send-keys.

**Reference:** See `GOALS.md` and `knowledge/research-spike-01-prior-art.md`

## Tasks

### Phase 1: Project Setup
- [ ] Initialize project structure (copy build tooling from terminal-server)
- [ ] Set up package.json with dependencies (@xterm/xterm, ws, etc.)
- [ ] Create basic vite + TypeScript config
- [ ] Verify build works with placeholder files

### Phase 2: tmux Integration (Server)
- [ ] Create tmux.ts module with functions:
  - `listSessions()` → array of {session, windows, panes}
  - `capturePane(target)` → string (pane content)
  - `sendKeys(target, keys)` → void
  - `resizePane(target, cols, rows)` → void
- [ ] Wrap tmux CLI calls (spawn child process)
- [ ] Add basic error handling for tmux not running

### Phase 3: WebSocket Server
- [ ] Create server.ts with HTTP + WebSocket
- [ ] Add `/api/sessions` endpoint (JSON list of sessions/panes)
- [ ] Add `/ws?pane=SESSION:WINDOW.PANE` WebSocket endpoint
- [ ] On WebSocket connect: start polling capture-pane (100ms interval)
- [ ] On WebSocket message: forward to send-keys
- [ ] Handle resize messages → resize-pane

### Phase 4: xterm.js Client
- [ ] Copy and adapt client.ts from terminal-server
- [ ] Add session selector UI (dropdown or list)
- [ ] Connect to selected pane via WebSocket
- [ ] Display pane content in xterm.js
- [ ] Forward keystrokes to server

### Phase 5: Attention Detection (Basic)
- [ ] Add patterns for Claude Code prompts:
  - "Allow" / "Deny" buttons
  - "? " question prompts
  - Waiting/idle indicators
- [ ] Add `detectAttention(content)` → boolean
- [ ] Surface attention state in session list UI
- [ ] (Optional) Add visual indicator (badge, highlight)

### Phase 6: Validation
- [ ] Test with a real Claude Code session in tmux
- [ ] Verify keystrokes work (approve a permission prompt)
- [ ] Verify attention detection triggers on Claude questions
- [ ] Document any issues in progress file

## Predictions

- [ ] tmux capture-pane output will include ANSI codes that xterm.js handles correctly [guess]
- [ ] Polling at 100ms will feel responsive enough without excessive CPU [guess]
- [ ] Claude Code prompts have consistent text patterns we can regex match [guess]
- [ ] send-keys will work reliably for simple inputs (y, n, Enter) [FACTS#research-spike-01]
- [ ] The terminal-server xterm.js setup will work with minimal changes [guess]

## Assumptions

- tmux is installed and running on the host
- At least one tmux session exists for testing
- Node.js 18+ available
- pnpm available for package management

## Out of Scope

- Push notifications (later session)
- Mobile UI optimization (later session)
- Claude Code hooks integration (later session)
- Multiple simultaneous pane views
- Session creation/management

## Codebase Context

> Prefer retrieval-led reasoning over pretraining-led reasoning.

**Facts:** research-spike-01:tmux capture-pane gives rendered screen state, send-keys works with caveats (escape timing, -l flag)|terminal-server:WebSocket+PTY server at ~/wbsm/Agent-client/terminal-server, uses @replit/ruspty and xterm.js|claude-hooks:Claude Code has Notification/Stop hooks that fire on events

**Heuristics:** tmux-is-emulator:tmux already does terminal emulation, capture-pane output is rendered not raw|pattern-over-parse:for detection, regex on plain text beats full terminal emulation|fork-then-adapt:copy working code then surgically replace the guts
