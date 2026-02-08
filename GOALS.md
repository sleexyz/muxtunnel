# Goals: mux

## North Star

**A project-first modern terminal multiplexer for the AI agent age.**

Hybrid of VS Code (project-centric workspace) and tmux (keyboard-driven multiplexing), with suckless philosophy: simple, composable, hackable. Web UI layer makes it moddable in ways native terminals can't be.

## Architecture

```
┌─────────────────────────────────────────┐
│  Tauri Window (native OS window)        │
│  ┌───────────────────────────────────┐  │
│  │  WebView                          │  │
│  │  ┌─────────┐ ┌─────────────────┐  │  │
│  │  │ Sidebar  │ │ xterm.js WebGL  │  │  │
│  │  │ Palette  │ │ (terminal)      │  │  │
│  │  │ Panels   │ │                 │  │  │
│  │  └─────────┘ └─────────────────┘  │  │
│  └──────────┬────────────────────────┘  │
│             │ Tauri IPC Channel          │
│  ┌──────────▼────────────────────────┐  │
│  │  Rust Core                        │  │
│  │  portable-pty → tmux/shell        │  │
│  │  project resolver system          │  │
│  │  settings, session tracking       │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Key Design Decisions

### Project Resolver

Pluggable name→directory resolution. Single active resolver (not chained).

```jsonc
{
  "resolver": "muxtunnel.projects",         // switch to "zoxide" etc.
  "muxtunnel.projects.roots": ["~/projects", "~/work"],
  "muxtunnel.projects.markers": [".git", "package.json", "Cargo.toml"],
  "zoxide.maxResults": 50
}
```

- VS Code-style dot-namespaced settings per resolver
- Built-in: `muxtunnel.projects` (open history + filesystem scan)
- Optional: `zoxide` (shells out if installed)
- Extensible: third-party resolvers use same interface
- Active tmux sessions always shown (separate from resolution)

```typescript
interface ProjectResolver {
  id: string;   // "muxtunnel.projects", "zoxide", "acme.monorepo-tool"
  resolve(query: string): Promise<ProjectResult[]>;
}

interface ProjectResult {
  name: string;  // display name
  path: string;  // absolute directory path
  score: number; // 0-1 normalized
}
```

### Hackability (three layers)

1. **Config** — settings.json, keybindings, hooks, resolver selection
2. **CSS/JS injection** — `~/.mux/plugins/{name}/` with style.css + init.js
3. **Rust plugins** — Tauri plugin system for system-level integrations

### Web = Moddable

The web UI isn't a compromise, it's the feature. CSS themes, custom panels, user scripts, ESM imports. Native terminals can't offer this.

---

## Milestone 1: Feature Parity in Tauri

Port the muxtunnel web prototype into a standalone Tauri app. All new code in `mux/`.

### Features (parity with current prototype)

- [ ] Tauri app with native window, single-binary distribution
- [ ] Rust backend: tmux session listing, PTY management (portable-pty)
- [ ] PTY streaming via Tauri IPC Channel (replaces WebSocket)
- [ ] Sidebar with session list, pane dots, drag-to-reorder
- [ ] Terminal view: xterm.js WebGL + CSS pane cropping
- [ ] Command palette (Cmd+P): session search + project resolution
- [ ] Claude session integration: thinking indicator, notification dots
- [ ] Settings system (~/.mux/settings.json) with hot reload
- [ ] Keyboard shortcuts (Cmd+P, Cmd+B, Ctrl+1-9, Ctrl+Tab)
- [ ] Background image customization
- [ ] Project resolver: `zoxide` resolver (port existing), `muxtunnel.projects` resolver (new)

### Not in M1

- Plugin system (CSS/JS injection)
- Non-tmux mode (direct shell without tmux)
- Mobile/responsive UI
- Own frecency database (just basic open-history tracking)
