# Sidebar Toggle (Cmd+B)

## Summary

Add a keyboard-toggled sidebar that, when open, takes up real layout space (pushing the terminal over) instead of floating on top. When closed, the existing hover-to-peek behavior remains.

## Current Behavior

- Sidebar is `position: fixed`, floats over the terminal
- Hidden off-screen via `translateX(-100%)`, slides in on hover
- 8px invisible trigger strip on the left edge activates it
- No keyboard shortcut, no persistent open state
- Selecting a pane collapses the sidebar (pointer-events hack for 300ms)

## Proposed Behavior

### Two modes: **pinned** (open) and **unpinned** (closed)

**Unpinned (default, current behavior):**
- Sidebar is fixed-position, hidden off-screen
- Hover trigger strip reveals it as an overlay
- Terminal takes full width

**Pinned (new):**
- Sidebar is `position: static` in the flex layout, 280px wide
- Terminal container shrinks to `calc(100% - 280px)`
- No hover trigger needed — sidebar is always visible
- No overlay — sidebar is part of the document flow

**Toggle:** `Cmd+B` (macOS) / `Ctrl+B` (Linux/Windows) toggles between pinned/unpinned.

## Implementation

### 1. State: `sidebarPinned` in App.tsx

```tsx
const [sidebarPinned, setSidebarPinned] = useState(false);
```

No localStorage persistence for now — default to unpinned on every page load.

### 2. Keyboard shortcut in App.tsx

Add a `useEffect` next to the existing Cmd+P handler:

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "b") {
      e.preventDefault();
      e.stopPropagation();
      setSidebarPinned((pinned) => !pinned);
    }
  };
  window.addEventListener("keydown", handler, true); // capture phase
  return () => window.removeEventListener("keydown", handler, true);
}, []);
```

Capture phase so it intercepts before xterm.js swallows the keystroke (same pattern as Cmd+P).

### 3. Conditional CSS class

Pass `sidebarPinned` to the sidebar and trigger elements:

```tsx
{!sidebarPinned && <div id="sidebar-trigger" />}
<Sidebar
  ...existing props
  pinned={sidebarPinned}
/>
```

Sidebar root div gets a `pinned` class:

```tsx
<div id="sidebar" className={pinned ? "pinned" : ""}>
```

### 4. CSS changes (index.html)

```css
/* Pinned mode: sidebar is in-flow, always visible */
#sidebar.pinned {
  position: static;
  transform: none;
  transition: none;
}
```

That's it — the existing `#sidebar` styles handle the unpinned case. When `.pinned` is added, `position: static` puts it in the flex flow and `transform: none` overrides the translateX.

The trigger div is conditionally rendered (not in DOM when pinned), so no hover interference.

### 5. Sidebar collapse behavior when pinned

When pinned and the user clicks a pane/session, do **not** call `collapseSidebar()`. The sidebar stays open. Only collapse on click when unpinned.

Pass `pinned` into `Sidebar` and gate the collapse:

```tsx
const handlePaneClick = (pane: TmuxPane) => {
  onSelectPane(pane.target);
  if (!pinned) collapseSidebar();
};
```

### 6. Terminal resize

xterm.js uses a `ResizeObserver` on its container to reflow. Since `#terminal-container` is `flex: 1`, it will naturally shrink when the sidebar enters the flow. The `ResizeObserver` in TerminalView should pick this up automatically — no manual `terminal.resize()` call needed.

**Verify:** confirm `FitAddon` or equivalent is wired to a `ResizeObserver` on `#terminal-container`. If it's on `window.resize` only, we'll need to add a container observer.

## Edge Cases

- **Cmd+B while hover-sidebar is visible:** Pin it in place (no jarring close-then-reopen).
- **Window narrow enough that 280px sidebar is too wide:** Respect existing `@media (max-width: 768px)` rule that hides the sidebar. Pinning on mobile does nothing (or auto-unpins).
- **Command palette (Cmd+P):** Independent of sidebar state. Palette overlays everything regardless.

## Not in scope

- Drag-to-resize sidebar width
- localStorage persistence of pinned state
- Animation when toggling between pinned/unpinned (keep it snappy)
- Settings UI for sidebar behavior

## Files touched

| File | Change |
|------|--------|
| `src/App.tsx` | `sidebarPinned` state, Cmd+B handler, conditional trigger, pass prop |
| `src/components/Sidebar.tsx` | Accept `pinned` prop, add className, gate collapse |
| `index.html` | `#sidebar.pinned` CSS rule |
