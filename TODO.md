# TODO

## ✅ Feature: Show process name per pane
**Status:** DONE

**Implementation notes:**
- Traverse process tree to find actual command (not just shell)
- Skip through wrappers (bash, zsh, npm, npx, node) up to 5 levels deep
- Handle NixOS full paths and macOS ps quirks with `extractCmdName()`
- Uses portable `ps -eo pid,ppid` instead of `pgrep -P` (macOS compatibility)

---

## ✅ Feature: Full session view
**Status:** DONE

**Implementation notes:**
- Session names are clickable in sidebar
- Sets `currentPane = null` and calls `showFullSession()`
- Crop container set to full session dimensions, no transform offset
- Session name highlighted when in full view mode

---

## ✅ Feature: Close panes
**Status:** DONE

**Implementation notes:**
- X button appears on hover (`.close-btn` with opacity transition)
- `DELETE /api/panes/:target` endpoint in server.ts
- `killPane(target)` function in tmux.ts calls `tmux kill-pane`
- Refreshes session list after closing
- Clears selection if closed pane was selected

---

## Feature: Claude Code session notifications

**Goal:** Show when Claude Code is done responding, with a Discord-style white dot indicator

### Data source
Claude Code stores session transcripts at `~/.claude/projects/<project-slug>/<session-id>.jsonl`

**sessions-index.json** provides:
- `sessionId`, `fullPath` to jsonl
- `summary` - AI-generated session summary
- `firstPrompt` - preview of initial prompt
- `messageCount`, `created`, `modified`
- `projectPath` - which project this session belongs to

**session.jsonl** (line-delimited JSON):
- Each line is a message (user prompt, assistant response, tool use, etc.)
- `type`: "user" | "assistant"
- `message.stop_reason`: null (streaming) | "end_turn" | "stop_sequence" (done)
- `timestamp` for ordering

### State detection
By reading the last line of the jsonl:
- Last message is "user" → Claude is processing (or waiting for tool result)
- Last message is "assistant" with `stop_reason` not null → **Done, waiting for input**
- Last message is "assistant" with `stop_reason` null → Still streaming

### Implementation plan

**1. Link panes to Claude sessions**
- For panes where process="claude", find the active session
- Match via: working directory (cwd in jsonl) + recency
- Or: parse Claude Code's internal state files if available

**2. Watch for completion events**
- Use `fs.watch` or `chokidar` on `~/.claude/projects/`
- When a `.jsonl` file changes, read last line
- If transition to "done" state → emit notification

**3. Track notification state**
- Server maintains: `Map<sessionId, { notified: boolean, viewedAt: Date }>`
- When session completes → set `notified: true`
- Include in API response: `pane.claudeSession = { sessionId, summary, notified }`

**4. Frontend notification indicator**
- Show white dot on panes with `notified: true`
- When pane is selected → call `POST /api/sessions/:id/viewed`
- Server clears `notified` flag

### What to show in sidebar
- **White dot** - Claude finished, needs attention (clears on view)
- **Session summary** - truncated AI summary as tooltip or subtitle
- **Status text** - "thinking..." | "done" | idle

### API additions
```
GET /api/sessions
  → includes: pane.claudeSession: { sessionId, summary, status, notified }

POST /api/claude-sessions/:id/viewed
  → clears notification for that session
```

---

## Future ideas
- Keyboard shortcuts for pane switching
- Drag to reorder panes
- Split pane from UI
- Rename windows/sessions
- Search/filter panes
