import { spawn, execSync } from "node:child_process";

export interface TmuxPane {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  paneId: string; // e.g., "%0"
  target: string; // e.g., "session:0.0"
  active: boolean;
  cols: number;
  rows: number;
  // Geometry for cropping (0-indexed, in character units)
  left: number;
  top: number;
}

export interface TmuxSession {
  name: string;
  windows: TmuxWindow[];
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: TmuxPane[];
}

/**
 * Check if tmux server is running
 */
export function isTmuxRunning(): boolean {
  try {
    execSync("tmux list-sessions", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all tmux sessions, windows, and panes
 */
export function listSessions(): TmuxSession[] {
  if (!isTmuxRunning()) {
    return [];
  }

  try {
    // Format: session_name:window_index:window_name:pane_index:pane_id:pane_active:pane_width:pane_height:pane_left:pane_top
    const output = execSync(
      'tmux list-panes -a -F "#{session_name}:#{window_index}:#{window_name}:#{pane_index}:#{pane_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_left}:#{pane_top}"',
      { encoding: "utf-8" }
    );

    const sessions = new Map<string, TmuxSession>();

    for (const line of output.trim().split("\n")) {
      if (!line) continue;

      const [sessionName, windowIndexStr, windowName, paneIndexStr, paneId, paneActiveStr, colsStr, rowsStr, leftStr, topStr] = line.split(":");
      const windowIndex = parseInt(windowIndexStr, 10);
      const paneIndex = parseInt(paneIndexStr, 10);
      const active = paneActiveStr === "1";
      const cols = parseInt(colsStr, 10);
      const rows = parseInt(rowsStr, 10);
      const left = parseInt(leftStr, 10);
      const top = parseInt(topStr, 10);

      const target = `${sessionName}:${windowIndex}.${paneIndex}`;

      const pane: TmuxPane = {
        sessionName,
        windowIndex,
        windowName,
        paneIndex,
        paneId,
        target,
        active,
        cols,
        rows,
        left,
        top,
      };

      if (!sessions.has(sessionName)) {
        sessions.set(sessionName, { name: sessionName, windows: [] });
      }

      const session = sessions.get(sessionName)!;
      let window = session.windows.find((w) => w.index === windowIndex);
      if (!window) {
        window = { index: windowIndex, name: windowName, panes: [] };
        session.windows.push(window);
      }
      window.panes.push(pane);
    }

    // Sort windows and panes
    for (const session of sessions.values()) {
      session.windows.sort((a, b) => a.index - b.index);
      for (const window of session.windows) {
        window.panes.sort((a, b) => a.paneIndex - b.paneIndex);
      }
    }

    return Array.from(sessions.values());
  } catch (err) {
    console.error("Failed to list tmux sessions:", err);
    return [];
  }
}

/**
 * Capture the current content of a pane
 * Returns the rendered screen content (with ANSI codes stripped by default)
 */
export function capturePane(target: string, options: { escape?: boolean; start?: number; end?: number } = {}): string {
  if (!isTmuxRunning()) {
    throw new Error("tmux is not running");
  }

  try {
    // -p: print to stdout
    // -e: include escape sequences (ANSI codes)
    // -t: target pane
    const args = ["capture-pane", "-p", "-t", target];

    if (options.escape) {
      args.push("-e"); // Include ANSI escape sequences
    }

    if (options.start !== undefined) {
      args.push("-S", options.start.toString());
    }

    if (options.end !== undefined) {
      args.push("-E", options.end.toString());
    }

    const output = execSync(`tmux ${args.join(" ")}`, { encoding: "utf-8" });
    return output;
  } catch (err) {
    throw new Error(`Failed to capture pane ${target}: ${err}`);
  }
}

/**
 * Capture pane with ANSI escape codes for xterm.js rendering
 */
export function capturePaneWithEscapes(target: string): string {
  return capturePane(target, { escape: true });
}

/**
 * Send keys to a tmux pane
 * @param target - pane target (e.g., "session:0.0")
 * @param keys - keys to send
 * @param literal - if true, use -l flag to send literal string (no special key handling)
 */
export function sendKeys(target: string, keys: string, literal: boolean = false): void {
  if (!isTmuxRunning()) {
    throw new Error("tmux is not running");
  }

  try {
    const args = ["send-keys", "-t", target];
    if (literal) {
      args.push("-l");
    }
    args.push(keys);

    execSync(`tmux ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`, { encoding: "utf-8" });
  } catch (err) {
    throw new Error(`Failed to send keys to pane ${target}: ${err}`);
  }
}

/**
 * Resize a tmux pane
 */
export function resizePane(target: string, cols: number, rows: number): void {
  if (!isTmuxRunning()) {
    throw new Error("tmux is not running");
  }

  try {
    // Note: tmux resize-pane adjusts relative to current size or sets exact with -x/-y
    execSync(`tmux resize-pane -t ${target} -x ${cols} -y ${rows}`, { encoding: "utf-8" });
  } catch (err) {
    // Resize can fail if it would make pane too small or window is zoomed
    console.warn(`Failed to resize pane ${target}: ${err}`);
  }
}

/**
 * Get detailed info about a specific pane
 */
export function getPaneInfo(target: string): TmuxPane | null {
  if (!isTmuxRunning()) {
    return null;
  }

  try {
    const output = execSync(
      `tmux display-message -t ${target} -p "#{session_name}:#{window_index}:#{window_name}:#{pane_index}:#{pane_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_left}:#{pane_top}"`,
      { encoding: "utf-8" }
    ).trim();

    const [sessionName, windowIndexStr, windowName, paneIndexStr, paneId, paneActiveStr, colsStr, rowsStr, leftStr, topStr] = output.split(":");

    return {
      sessionName,
      windowIndex: parseInt(windowIndexStr, 10),
      windowName,
      paneIndex: parseInt(paneIndexStr, 10),
      paneId,
      target,
      active: paneActiveStr === "1",
      cols: parseInt(colsStr, 10),
      rows: parseInt(rowsStr, 10),
      left: parseInt(leftStr, 10),
      top: parseInt(topStr, 10),
    };
  } catch (err) {
    console.error(`Failed to get pane info for ${target}:`, err);
    return null;
  }
}
