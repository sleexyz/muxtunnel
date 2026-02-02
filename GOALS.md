# Goals: MuxTunnel

## North Star

**An attention-aware tmux client that surfaces sessions when they need you.**

Like macOS Stage Manager, but for terminal sessions. The session that needs your attention comes to the front - on your phone, in a browser, wherever you are. You respond, it recedes, you continue with your day.

## The Insight

This is an **alternative tmux client**, not a terminal emulator. It layers on top of your existing tmux setup:

```
┌─────────────────────────────────────────────────────────┐
│  MuxTunnel (attention-aware client)                     │
│    - Watches all sessions                               │
│    - Surfaces what needs you                            │
│    - Accepts responses                                  │
├─────────────────────────────────────────────────────────┤
│  tmux (session management, terminal emulation)          │
│    - Already maintains screen state                     │
│    - capture-pane gives us rendered output              │
│    - send-keys lets us respond                          │
├─────────────────────────────────────────────────────────┤
│  Programs (Claude Code, vim, builds, etc.)              │
│    - Some have native hooks (Claude Code)               │
│    - Others we detect via screen patterns               │
└─────────────────────────────────────────────────────────┘
```

**Key realization**: tmux already IS the terminal emulator. `capture-pane` gives us rendered screen state, not raw escape sequences. We don't need pyte/vt10x for detection - just pattern matching on text. We might use xterm.js for pretty web rendering, but that's display, not detection.

## Why This Matters

I run multiple long-running Claude Code sessions. Currently:
- I have to actively monitor to know when Claude needs input
- If I step away, work stalls until I return
- No way to respond quickly when I'm mobile

With MuxTunnel:
- Sessions that need me pop up (Stage Manager style)
- Quick response from phone, session recedes
- Back at desktop, everything is where I left it

## Two Detection Strategies

### Generic: Screen Scraping
Works for any TUI. Capture pane, pattern match for prompts/questions.
- Pro: Works with anything (vim, htop, any CLI)
- Con: Fragile to UI changes, heuristic

### Native: Direct Integration
For programs with APIs (Claude Code hooks, SDK).
- Pro: Semantic events ("waiting for input"), reliable
- Con: Per-program integration work

**Start with Claude Code native integration** (hooks exist), **keep scraping as fallback** for the general case.

## Success Criteria

1. **Detection**: Know when any session needs attention
2. **Surfacing**: Session "pops to front" wherever I am (phone, browser)
3. **Context**: See what it's asking (enough to respond intelligently)
4. **Response**: Quick actions + text input
5. **Recede**: After responding, session goes back to background
6. **Seamless**: Desktop tmux session continues unaffected

## UX Vision: Stage Manager for Terminals

```
Phone screen (idle):
┌─────────────────────┐
│                     │
│   (nothing - all    │
│    sessions quiet)  │
│                     │
└─────────────────────┘

Phone screen (attention needed):
┌─────────────────────┐
│ ╭─ claude: myproj ─╮│
│ │                  ││
│ │ Allow Bash:      ││
│ │ npm install      ││
│ │                  ││
│ │ [Allow] [Deny]   ││
│ ╰──────────────────╯│
│                     │
│ ┄┄ 2 other sessions ┄│
└─────────────────────┘
```

When you respond, the card slides away. If another session needs you, it slides in. If nothing needs you, the screen is empty/minimal.

## Goal Hierarchy

```
MuxTunnel
├── G1: Read from tmux [SPIKE]
│   ├── List sessions/panes programmatically
│   ├── capture-pane → plain text (tmux already rendered it)
│   ├── Pattern match for "needs attention" states
│   └── Detect Claude Code sessions specifically
│
├── G2: Claude Code Integration [SPIKE]
│   ├── Hook into Notification/Stop events
│   ├── Parse session JSONL for context
│   └── Use SDK for programmatic responses (maybe)
│
├── G3: Write to tmux [SPIKE]
│   ├── send-keys for responses
│   ├── Handle y/n, Enter, text input
│   └── Verify response was received
│
├── G4: Notification + Surfacing [BUILD]
│   ├── Push notification (ntfy.sh / Pushover)
│   ├── Web UI that shows "front" session
│   ├── Session queue when multiple need attention
│   └── Stage Manager-style transitions
│
├── G5: Response UI [BUILD]
│   ├── Mobile-first card-based interface
│   ├── Quick action buttons
│   ├── Text input
│   └── Render pane content (plain text or xterm.js)
│
└── G6: Always-On [POLISH]
    ├── Background daemon
    ├── Reconnection handling
    └── Works alongside normal tmux usage
```

## Technical Clarifications

**Terminal emulation**: Not needed for detection. tmux's `capture-pane` gives us already-rendered screen content. Pattern matching on plain text is sufficient.

**xterm.js / terminal rendering**: Optional, for display. If we want to show the pane content with colors/formatting in the web UI, xterm.js can render ANSI output. But plain text works fine for MVP.

**Claude Code hooks**: `Notification` and `Stop` hooks fire on relevant events. These give us semantic detection without scraping. Hooks receive JSON with session_id, transcript_path, message.

**Claude Code SDK**: Can run headless queries. Potential path for programmatic responses, but send-keys into existing session might be simpler.

## Constraints

- **Layers on tmux**: Not replacing it, extending it
- **Phone-first UX**: Small screen, quick interactions
- **Multiple sessions**: Handle N concurrent sessions gracefully
- **Non-invasive**: Normal tmux workflow unaffected

## Out of Scope (For Now)

- Full terminal emulation on phone
- Starting/stopping sessions remotely
- Voice I/O
- Non-tmux terminal multiplexers

## Open Questions

- What's the right polling interval vs. push notification latency tradeoff?
- How to handle "stale" attention requests (user already responded at desktop)?
- Session naming/identification UX when you have many sessions?
- Should responses go through SDK or send-keys?
