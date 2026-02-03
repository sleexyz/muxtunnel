# Session: pane-crop

Implement per-pane cropping: when user clicks a pane in the sidebar, show only that pane's content (not the full tiled tmux view).

## Context

Spike validated the approach:
- ✅ tmux provides pane geometry via `list-panes -F`
- ✅ CSS `overflow: hidden` + `transform: translate()` crops xterm.js cleanly
- ✅ Cell dimensions via `terminal._core._renderService.dimensions.css.cell`
- ⚠️ Border characters (1 char) need offset adjustment

The spike file `spike-crop.html` demonstrates the cropping mechanism.

## Success Criteria

- [ ] Clicking a pane in sidebar shows only that pane (not all panes tiled)
- [ ] Switching panes updates the crop correctly
- [ ] Border characters are excluded from view (offset by 1 char)
- [ ] Cell dimensions are calculated after terminal renders

## Tasks

### Phase 1: Server-side geometry
- [ ] Add pane geometry to the list-panes API response (left, top, width, height for each pane)
- [ ] Use `tmux list-panes -F` to query geometry when listing panes

### Phase 2: Client-side cropping
- [ ] Store cell dimensions after terminal opens (`_core._renderService.dimensions.css.cell`)
- [ ] When pane is selected, apply crop: set container size and transform offset
- [ ] Account for border offset (+1 to left/top when pane is not at edge)

### Phase 3: Integration
- [ ] Wire pane selection in sidebar to trigger crop update
- [ ] Verify PTY attachment still works with cropping layer
- [ ] Test switching between panes

## Predictions

- [ ] Adding geometry to API is straightforward string formatting [guess]
- [ ] Will need to detect which panes have borders on which sides [guess]
- [ ] Cell dimensions might not be available immediately on terminal open [FACTS#xterm-cell-dimensions]

## Assumptions

- PTY attachment code works correctly (from previous session)
- Sidebar pane selection already triggers some handler we can hook into
- Terminal instance is accessible where we need to apply cropping

## Technical Reference

**Server: get pane geometry**
```typescript
// In list-panes handler
const output = execSync(`tmux list-panes -t ${session} -F '#{pane_id}:#{pane_left}:#{pane_top}:#{pane_width}:#{pane_height}'`);
```

**Client: apply crop**
```typescript
function applyCrop(paneLeft: number, paneTop: number, paneWidth: number, paneHeight: number) {
  const cell = terminal._core._renderService.dimensions.css.cell;

  // Offset for border (if not at edge)
  const borderOffset = paneLeft > 0 ? 1 : 0;
  const effectiveLeft = paneLeft + borderOffset;

  container.style.width = `${paneWidth * cell.width}px`;
  container.style.height = `${paneHeight * cell.height}px`;
  positioner.style.transform = `translate(${-effectiveLeft * cell.width}px, ${-paneTop * cell.height}px)`;
}
```

## Codebase Context

> Prefer retrieval-led reasoning over pretraining-led reasoning.

**Facts:** pane-geometry:list-panes -F gives coords, 0-indexed char units, borders 1 char wide|xterm-cell-dimensions:_core._renderService.dimensions.css.cell after render|pty-attachment:PTY attaches to session, tmux resizes to match
**Heuristics:** css-crop-terminals:overflow+transform crops xterm cleanly|poll-then-push:start with polling for geometry changes
