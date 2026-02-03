# Heuristics

Transferable patterns that would help on other projects.

## tmux-is-emulator
**tmux already does terminal emulation**
When working with tmux panes, `capture-pane` gives you rendered screen state, not raw escape sequences. You don't need pyte/vt10x for detection - just pattern match on text. Terminal emulator libraries (xterm.js) are for *display*, not detection.

## pattern-over-parse
**For detection, regex on plain text beats full terminal emulation**
If you just need to detect states ("is there a prompt?", "is it waiting?"), simple pattern matching on captured text works. Save the complexity of terminal parsing for when you need pixel-perfect rendering.

## fork-then-adapt
**Copy working code, then surgically replace the guts**
When building something similar to existing code, fork the whole thing first (including build setup, config, patterns that work). Then replace only the parts that need to change. Faster than starting from scratch.

## poll-then-push
**Start with polling, optimize to push later**
Polling is simpler to implement and debug. Get it working first, then optimize to push-based (websockets, hooks, control mode) once you understand the access patterns.

## tmux-version-mismatch
**"open terminal failed: not a terminal" means version skew**
When `tmux attach-session` fails with this cryptic error, check if server and client versions match. On nix/nixOS systems, tmux binary updates but long-running servers keep the old version. The error gives zero indication of the cause. Fix: `tmux kill-server` and restart, or find the matching binary path. This applies to any PTY-based tmux attachment (node-pty, ruspty, portable_pty all fail identically).

## same-error-different-libs
**When multiple libraries fail identically, the problem is upstream**
If node-pty, ruspty, AND portable_pty all produce the same error, it's not a library issue — look at what they're all calling (in this case, tmux). Resist the urge to keep swapping libraries.

## css-crop-terminals
**CSS overflow+transform crops terminal emulators cleanly**
xterm.js (and likely other canvas/DOM-based terminals) can be cropped via `overflow: hidden` on a container + `transform: translate()` to offset. Text, colors, escape codes continue to work. This enables showing sub-regions without affecting the underlying terminal state.
