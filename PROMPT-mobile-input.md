# Session: mobile-input

Add mobile-friendly input for Claude Code terminal sessions using React.

## Context

Current state: Vanilla TypeScript with xterm.js, DOM manipulation for sidebar. Works well on desktop but no mobile input support.

**Goal:** Mobile users can:
1. See terminal output (keep current xterm rendering)
2. Type messages and send them to the terminal
3. Stop current operation (Ctrl+C)

## Key Insight

```
Mobile keyboard + textarea → submit → tmux send-keys → terminal
```

Don't need to detect input state. User knows when Claude wants input. Just provide a simple input mechanism.

## Success Criteria

- [x] React app renders (converts existing vanilla to React)
- [x] Input field visible on mobile (fixed at bottom)
- [x] Submit sends text + Enter to tmux pane
- [x] Stop button sends Ctrl+C
- [x] Works alongside existing terminal rendering

## Tasks

### Phase 1: Add React to project
- [x] Install react, react-dom, @types/react, @types/react-dom
- [x] Add @vitejs/plugin-react to vite.config.ts
- [x] Create src/main.tsx entry point
- [x] Update index.html to use React root

### Phase 2: Convert to React components
- [x] Create App.tsx with existing layout structure
- [x] Create Sidebar.tsx (sessions list)
- [x] Create TerminalView.tsx (xterm container + cropping)
- [x] Preserve existing WebSocket and terminal logic in hooks

### Phase 3: Add mobile input bar
- [x] Create InputBar.tsx component (fixed bottom on mobile)
- [x] Textarea for multi-line input
- [x] Submit button (sends text + Enter)
- [x] Stop button (sends Ctrl+C)
- [x] Style for mobile: larger touch targets, visible keyboard

### Phase 4: Wire up input to tmux
- [x] Add server endpoint: POST /api/panes/:target/input
- [x] Server uses `tmux send-keys -t TARGET "text" Enter`
- [x] Stop endpoint: POST /api/panes/:target/interrupt
- [x] Server uses `tmux send-keys -t TARGET C-c`

### Phase 5: Mobile styling
- [x] Hide sidebar on mobile (or make collapsible)
- [x] Input bar always visible when pane selected
- [ ] Handle virtual keyboard (viewport resize)

## Technical Reference

**Send keys to tmux pane:**
```bash
tmux send-keys -t "session:0.1" "hello world" Enter
tmux send-keys -t "session:0.1" C-c
```

**React + Vite setup:**
```typescript
// vite.config.ts
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()]
})
```

**InputBar component sketch:**
```tsx
function InputBar({ target }: { target: string }) {
  const [text, setText] = useState('')

  const send = async () => {
    await fetch(`/api/panes/${encodeURIComponent(target)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    })
    setText('')
  }

  const stop = async () => {
    await fetch(`/api/panes/${encodeURIComponent(target)}/interrupt`, {
      method: 'POST'
    })
  }

  return (
    <div className="input-bar">
      <textarea value={text} onChange={e => setText(e.target.value)} />
      <button onClick={send}>Send</button>
      <button onClick={stop}>Stop</button>
    </div>
  )
}
```

**Server endpoint sketch:**
```typescript
app.post('/api/panes/:target/input', async (req, res) => {
  const { target } = req.params
  const { text } = req.body
  // Escape for tmux send-keys
  await exec(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(text)} Enter`)
  res.json({ ok: true })
})
```

## File Structure

```
src/
  main.tsx          # React entry point
  App.tsx           # Main layout
  components/
    Sidebar.tsx     # Sessions list
    TerminalView.tsx # xterm wrapper
    InputBar.tsx    # Mobile input
  hooks/
    useWebSocket.ts # WS connection logic
    useSessions.ts  # Sessions polling
  types.ts          # Shared types (TmuxPane, etc)
```

## Considerations

1. **xterm.js + React** — xterm needs imperative DOM access; use ref + useEffect
2. **WebSocket lifecycle** — manage in hook, cleanup on unmount
3. **Input escaping** — handle special chars in tmux send-keys
4. **Mobile viewport** — virtual keyboard changes layout; use visualViewport API if needed

## Out of Scope

- Smart prompt detection (just dumb input for now)
- Multi-line fancy editor
- Session creation/management from mobile

## Dependencies to Add

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.2.0"
  }
}
```
