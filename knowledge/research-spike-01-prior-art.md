# Research Spike 01: Prior Art Summary

## Key Discovery: Two Viable Paths

The research reveals two fundamentally different approaches:

### Path A: tmux Scraping (Analog Hole)
Work with Claude Code TUI as-is, capture/parse screen state via tmux.

### Path B: Claude Code Native Integration
Use Claude Code's built-in hooks and SDK - skip the TUI entirely.

---

## Path A: tmux-Based Approach

### Reading from tmux

**Best option: Control Mode (`tmux -CC`)**
- Real-time `%output` notifications for every pane
- No polling needed - push-based
- Used by iTerm2 for tmux integration

**Simpler option: `capture-pane`**
- `tmux capture-pane -e -p -t %0` - captures with ANSI codes
- Poll-based, but simple to implement
- `libtmux` (Python) wraps this nicely

**Screen parsing:**
- `pyte` (Python) / `vt10x` (Go) - parse ANSI into 2D screen buffer
- Can query text at specific positions
- Enables "is there a prompt at line X?" checks

### Writing to tmux

**`tmux send-keys`** works reliably with caveats:
- Use `-l` for literal text
- Add delay after `Escape` key
- `libtmux` wraps this well

### Existing tmux → Phone Solutions

| Tool | What it does |
|------|--------------|
| **tmux-notify** | Plugin that polls for prompt, sends Pushover/Telegram notifications |
| **Muxile** | tmux plugin, Cloudflare Worker relay, phone browser access via QR |
| **Webmux** | Rust/Vue PWA for tmux access, mobile-friendly |
| **ttyd** | Web terminal, can attach to tmux sessions |

**tmux-notify** is closest to what we want but naive (checks if output ends with `$`/`#`).

---

## Path B: Claude Code Native Integration

### Claude Code Hooks (Most Relevant)

Claude Code has a hooks system in `.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [{
      "matcher": "*",
      "hooks": [{"type": "command", "command": "your-notify-script.sh"}]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{"type": "command", "command": "your-stop-script.sh"}]
    }]
  }
}
```

**Key hooks for our use case:**
| Hook | Fires When |
|------|------------|
| `Notification` | Claude sends alerts/notifications (e.g., "waiting for input") |
| `Stop` | Claude finishes responding |
| `PreToolUse` | Before a tool runs (can block) |
| `PermissionRequest` | Permission needed (can block) |

Hooks receive JSON on stdin with `session_id`, `transcript_path`, `message`, etc.

### Claude Code SDK

Can run Claude Code programmatically without TUI:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Do the thing",
  options: { allowedTools: ["Read", "Write", "Bash"] }
})) {
  console.log(message);
}
```

- Streams all messages, tool uses, results
- Session management for multi-turn
- Could be the "response" mechanism from phone

### Session Transcripts

Full conversation history at `~/.claude/projects/.../session.jsonl`
- Can parse to understand current state
- Tools like `claude-code-log` convert to HTML

---

## Recommendation

**Hybrid approach:**

1. **Detection**: Use Claude Code **hooks** (`Notification`, `Stop`) - no scraping needed
2. **Context**: Parse **session JSONL** or use **tmux capture-pane** for screen state
3. **Notification**: Push via **ntfy.sh** or **Pushover** (proven, simple)
4. **Response UI**: Web app that either:
   - Uses **Claude Code SDK** to send responses programmatically, OR
   - Uses **tmux send-keys** to type into existing session
5. **Fallback**: Keep tmux scraping path for non-Claude-Code TUIs later

**Why hooks over scraping:**
- Semantic events ("Claude needs input") vs parsing pixels
- Less fragile - doesn't break if TUI changes
- Lower latency - push not poll

**Why keep tmux path:**
- Works for any TUI (vim, htop, other agents)
- Hooks only work for Claude Code
- "Analog hole" approach is more general

---

## Quick Wins to Validate

1. **Test hooks**: Add a `Notification` hook that writes to a file, see what fires
2. **Test capture-pane + pyte**: Can we detect Claude Code's "waiting for input" state?
3. **Test send-keys**: Can we send `y` to approve a permission prompt?
4. **Test SDK**: Can we run a headless query and get results?

---

## Sources

- [Claude Code Hooks Docs](https://code.claude.com/docs/en/hooks)
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [libtmux](https://github.com/tmux-python/libtmux)
- [pyte](https://github.com/selectel/pyte)
- [tmux Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode)
- [tmux-notify](https://github.com/rickstaa/tmux-notify)
- [Muxile](https://github.com/bjesus/muxile)
- [Webmux](https://github.com/nooesc/webmux)
