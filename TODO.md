# TODO

## Feature: Show process name per pane
**Goal:** Display what's actually running in each pane in the sidebar

**Current state:** Sidebar shows `window:pane` (e.g., "0:0", "0:1")

**Desired state:** Show the running process alongside, e.g., "0:0 npm run dev" or "0:1 vim"

**Implementation:**
1. tmux provides `pane_pid` and `pane_current_command`
2. `pane_current_command` is often just "zsh" or "bash" (the shell)
3. To get the actual command, check child processes: `pgrep -P <pane_pid>`
4. Use `ps -o command -p <child_pid>` to get the command name
5. If no children, fall back to `pane_current_command`
6. Add to `listSessions()` in tmux.ts, return as `pane.process`
7. Display in sidebar: `<span class="pane-id">0:0</span> <span class="process">npm run dev</span>`

**Edge cases:**
- Multiple children: show first/primary child
- No children: show shell name (zsh, bash)
- Long command names: truncate with ellipsis

---

## Feature: Full session view
**Goal:** Click session name in sidebar to see the full tiled tmux view (all panes together)

**Current state:** Clicking a pane crops to show only that pane

**Desired state:** Clicking session name shows full session (no cropping), clicks pass through to panes

**Implementation:**
1. Make session name clickable in sidebar (currently just a label)
2. When clicked, set `currentPane = null` (or a special "full session" state)
3. In `applyCropForPane()`, if no pane selected:
   - Set crop-container to full session dimensions
   - Set transform to `translate(0, 0)` (no offset)
4. Mouse clicks already work (session-relative coordinates)
5. Update header to show session name instead of pane target

**UI changes:**
- Session name gets hover/click styling like panes
- Visual indicator when viewing full session vs single pane

---

## Feature: Close panes
**Goal:** Allow closing individual panes from the UI

**Current state:** No way to close panes from web UI

**Desired state:** X button or similar to close a pane

**Implementation:**
1. Add close button to each pane item in sidebar (visible on hover)
2. Clicking close sends request to server: `POST /api/pane/:target/close` or similar
3. Server calls `tmux kill-pane -t TARGET`
4. Add `killPane(target)` to tmux.ts
5. After closing, refresh sessions list
6. If closed pane was selected, select another pane or show full session

**Safety:**
- No confirmation dialog (user can undo with tmux if needed)
- Don't allow closing last pane in session? Or let tmux handle it (session closes)

**API:**
```
DELETE /api/panes/:target
  → calls tmux kill-pane -t TARGET
  → returns { success: true } or { error: "..." }
```
