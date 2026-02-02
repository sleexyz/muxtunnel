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
