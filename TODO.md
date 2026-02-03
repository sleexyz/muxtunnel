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

## Future ideas
- Keyboard shortcuts for pane switching
- Drag to reorder panes
- Split pane from UI
- Rename windows/sessions
- Search/filter panes
