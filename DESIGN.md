# MuxTunnel Design Guidelines

## Principle: Terminal First

The terminal is the product. Every UI element — sidebar, command palette, input bar — exists to serve the terminal, not compete with it. All surfaces must look like they belong *inside* a terminal.

## Typography

All text uses the terminal font stack. No sans-serif anywhere.

| Token | Value |
|---|---|
| `--font` | `Menlo, Monaco, 'Courier New', monospace` |
| `--font-size` | `12px` (user-configurable via settings) |

## Color Palette

Derived from the xterm.js theme. The terminal's foreground/background are the source of truth.

### Base

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#1e1e1e` | Terminal background, all surfaces |
| `--fg` | `#d4d4d4` | Terminal foreground, primary text |
| `--fg-dim` | `#888` | Secondary/muted text |
| `--fg-faint` | `#555` | Disabled, inactive elements |
| `--border` | `rgba(255,255,255,0.08)` | Subtle dividers, panel edges |

### ANSI-Derived Accents

Use terminal ANSI colors for semantic meaning, not custom brand colors.

| Token | Hex | Usage |
|---|---|---|
| `--blue` | `#3794ff` | Selection ring, active indicator, links |
| `--selection` | `#094771` | Selected row background (matches terminal selection) |
| `--orange` | `#f0a050` | Claude processes |
| `--red` | `#f48771` | Destructive actions, close hover, errors |

### Shadows

Used sparingly, only on floating panels (unpinned sidebar, palette).

```
box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);
```

## Surfaces

All backgrounds are `--bg` (`#1e1e1e`). There are no lighter card backgrounds or elevation levels. Separation is achieved through borders and spacing, not background color changes.

Hover state: `#2a2d2e` (barely perceptible lift).

## Sidebar

Compact, one-line-per-session. Minimal chrome.

```
session-name   ● ● ○
```

- Session label: `--fg` weight 600
- Process dots: 7px circles
  - Default: `--fg-faint` (`#555`)
  - Claude active: `--orange` solid
  - Claude thinking: `--orange` solid + pulse glow
  - Claude done: `--orange` hollow ring
  - Needs attention: blink animation
- Selected session: `--selection` background
- Selected dot: `--blue` outline ring
- Close button: hidden until row hover

## Spacing

Tight. Terminal users expect density.

- Sidebar padding: `12px`
- Row padding: `5px 6px`
- Row gap: `1px`
- Dot gap: `4px`

## Animation

Restrained. Only used for state communication, never decoration.

| Animation | Duration | Purpose |
|---|---|---|
| Sidebar slide | `0.08s` | Appear/disappear on hover |
| Dot pulse glow | `1.5s` | Claude is thinking |
| Dot blink | `0.8s` | Pane needs attention |
| Hover scale | `0.1s` | Dot hover affordance |

## Don'ts

- No sans-serif fonts
- No bright/white backgrounds
- No rounded "pill" buttons
- No color that doesn't trace back to the terminal palette
- No animation for decoration
