import { execSync, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

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
  // Process info
  pid: number;
  process: string; // The actual running command (not just shell name)
}

export interface TmuxSession {
  name: string;
  windows: TmuxWindow[];
  activity?: number;
  path?: string;
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: TmuxPane[];
}

/**
 * Extract clean command name from ps output
 * Handles: /path/to/cmd, "cmd args", and combinations
 */
function extractCmdName(psOutput: string): string {
  // First, get just the first word (in case args are included)
  const firstWord = psOutput.split(/\s+/)[0];
  // Then extract basename from path
  const lastSlash = firstWord.lastIndexOf("/");
  return lastSlash >= 0 ? firstWord.slice(lastSlash + 1) : firstWord;
}

/**
 * Get child PIDs of a process (portable across macOS and Linux)
 */
function getChildPids(ppid: number): number[] {
  try {
    // Use ps which works consistently across platforms
    const output = execSync(`ps -eo pid,ppid`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const children: number[] = [];
    for (const line of output.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parseInt(parts[1], 10) === ppid) {
        children.push(parseInt(parts[0], 10));
      }
    }
    return children;
  } catch {
    return [];
  }
}

/**
 * Get the effective process name for a pane
 * Traverses the process tree to find the actual running command (skipping shells and wrappers)
 */
function getEffectiveProcess(pid: number, currentCommand: string): string {
  // Commands to skip through when looking for the "real" process
  const wrappers = ["zsh", "bash", "sh", "fish", "tcsh", "csh", "-zsh", "-bash", "-sh", "npm", "npx", "node"];

  // If not a wrapper, return the current command
  if (!wrappers.includes(currentCommand)) {
    return currentCommand;
  }

  try {
    // Walk down the process tree until we find a non-wrapper or hit a leaf
    let currentPid = pid;
    let depth = 0;
    const maxDepth = 5; // Prevent infinite loops

    while (depth < maxDepth) {
      const children = getChildPids(currentPid);

      if (children.length === 0) {
        // No children - get this process's command
        if (currentPid !== pid) {
          const cmd = execSync(`ps -o comm= -p ${currentPid}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
          if (cmd) {
            return extractCmdName(cmd);
          }
        }
        return currentCommand;
      }

      // Check the first child
      const childPid = children[0];
      const childCmd = execSync(`ps -o comm= -p ${childPid}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();

      if (!childCmd) {
        return currentCommand;
      }

      const cmdName = extractCmdName(childCmd);

      // If this is not a wrapper, we found our target
      if (!wrappers.includes(cmdName) && !wrappers.includes(`-${cmdName}`)) {
        return cmdName;
      }

      // Otherwise, continue down the tree
      currentPid = childPid;
      depth++;
    }

    return currentCommand;
  } catch {
    return currentCommand;
  }
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
    // Format: session_name:window_index:window_name:pane_index:pane_id:pane_active:pane_width:pane_height:pane_left:pane_top:pane_pid:pane_current_command
    const output = execSync(
      'tmux list-panes -a -F "#{session_name}:#{window_index}:#{window_name}:#{pane_index}:#{pane_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_left}:#{pane_top}:#{pane_pid}:#{pane_current_command}"',
      { encoding: "utf-8" }
    );

    const sessions = new Map<string, TmuxSession>();

    for (const line of output.trim().split("\n")) {
      if (!line) continue;

      const [sessionName, windowIndexStr, windowName, paneIndexStr, paneId, paneActiveStr, colsStr, rowsStr, leftStr, topStr, pidStr, currentCommand] = line.split(":");
      const windowIndex = parseInt(windowIndexStr, 10);
      const paneIndex = parseInt(paneIndexStr, 10);
      const active = paneActiveStr === "1";
      const cols = parseInt(colsStr, 10);
      const rows = parseInt(rowsStr, 10);
      const left = parseInt(leftStr, 10);
      const top = parseInt(topStr, 10);
      const pid = parseInt(pidStr, 10);
      const process = getEffectiveProcess(pid, currentCommand);

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
        pid,
        process,
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
 * Get the dimensions of a session's current window
 * Returns the full window size (width x height in characters)
 */
export function getSessionDimensions(sessionName: string): { width: number; height: number } | null {
  if (!isTmuxRunning()) {
    return null;
  }

  try {
    const output = execSync(
      `tmux display-message -t "${sessionName}" -p "#{window_width}:#{window_height}"`,
      { encoding: "utf-8" }
    ).trim();

    const [widthStr, heightStr] = output.split(":");
    const width = parseInt(widthStr, 10);
    const height = parseInt(heightStr, 10);

    if (isNaN(width) || isNaN(height)) {
      return null;
    }

    return { width, height };
  } catch (err) {
    console.error(`Failed to get session dimensions for ${sessionName}:`, err);
    return null;
  }
}

/**
 * Kill a tmux pane
 */
export function killPane(target: string): void {
  if (!isTmuxRunning()) {
    throw new Error("tmux is not running");
  }

  try {
    execSync(`tmux kill-pane -t ${target}`, { encoding: "utf-8" });
  } catch (err) {
    throw new Error(`Failed to kill pane ${target}: ${err}`);
  }
}

export function killSession(name: string): void {
  if (!isTmuxRunning()) {
    throw new Error("tmux is not running");
  }

  try {
    execSync(`tmux kill-session -t ${name}`, { encoding: "utf-8" });
  } catch (err) {
    throw new Error(`Failed to kill session ${name}: ${err}`);
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
      `tmux display-message -t ${target} -p "#{session_name}:#{window_index}:#{window_name}:#{pane_index}:#{pane_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_left}:#{pane_top}:#{pane_pid}:#{pane_current_command}"`,
      { encoding: "utf-8" }
    ).trim();

    const [sessionName, windowIndexStr, windowName, paneIndexStr, paneId, paneActiveStr, colsStr, rowsStr, leftStr, topStr, pidStr, currentCommand] = output.split(":");
    const pid = parseInt(pidStr, 10);
    const process = getEffectiveProcess(pid, currentCommand);

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
      pid,
      process,
    };
  } catch (err) {
    console.error(`Failed to get pane info for ${target}:`, err);
    return null;
  }
}

/**
 * Create a new tmux session (async)
 */
export async function createSessionAsync(name: string, cwd: string): Promise<void> {
  await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-c", cwd]);
}

// ─── Async variants (non-blocking, for polling paths) ───────────────────────

/**
 * Fetch the entire process table in a single `ps` call.
 * Returns a map of PID → { ppid, comm } for in-memory tree walking.
 */
async function getProcessTable(): Promise<Map<number, { ppid: number; comm: string }>> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf-8" });
    const table = new Map<number, { ppid: number; comm: string }>();
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (match) {
        table.set(parseInt(match[1], 10), {
          ppid: parseInt(match[2], 10),
          comm: match[3],
        });
      }
    }
    return table;
  } catch {
    return new Map();
  }
}

/**
 * In-memory process tree walk using a pre-fetched process table.
 * Replaces N×depth execSync("ps") calls with pure lookups.
 */
function getEffectiveProcessFromTable(
  pid: number,
  currentCommand: string,
  table: Map<number, { ppid: number; comm: string }>,
): string {
  const wrappers = ["zsh", "bash", "sh", "fish", "tcsh", "csh", "-zsh", "-bash", "-sh", "npm", "npx", "node"];

  if (!wrappers.includes(currentCommand)) {
    return currentCommand;
  }

  let currentPid = pid;
  let depth = 0;
  const maxDepth = 5;

  while (depth < maxDepth) {
    const children: number[] = [];
    for (const [childPid, info] of table) {
      if (info.ppid === currentPid) {
        children.push(childPid);
      }
    }

    if (children.length === 0) {
      if (currentPid !== pid) {
        const proc = table.get(currentPid);
        if (proc) {
          const cmd = extractCmdName(proc.comm);
          if (cmd) return cmd;
        }
      }
      return currentCommand;
    }

    const childPid = children[0];
    const childInfo = table.get(childPid);
    if (!childInfo) return currentCommand;

    const cmdName = extractCmdName(childInfo.comm);
    if (!wrappers.includes(cmdName) && !wrappers.includes(`-${cmdName}`)) {
      return cmdName;
    }

    currentPid = childPid;
    depth++;
  }

  return currentCommand;
}

/**
 * Async version of listSessions.
 * Runs tmux list-panes and ps in parallel, then does in-memory tree walking.
 */
export async function listSessionsAsync(): Promise<TmuxSession[]> {
  try {
    const [tmuxOutput, processTable] = await Promise.all([
      execFileAsync(
        "tmux",
        ["list-panes", "-a", "-F",
          "#{session_name}:#{window_index}:#{window_name}:#{pane_index}:#{pane_id}:#{pane_active}:#{pane_width}:#{pane_height}:#{pane_left}:#{pane_top}:#{pane_pid}:#{pane_current_command}:#{session_activity}:#{session_path}"],
        { encoding: "utf-8" },
      ),
      getProcessTable(),
    ]);

    const sessions = new Map<string, TmuxSession>();

    for (const line of tmuxOutput.stdout.trim().split("\n")) {
      if (!line) continue;

      const parts = line.split(":");
      const sessionName = parts[0];
      const windowIndexStr = parts[1];
      const windowName = parts[2];
      const paneIndexStr = parts[3];
      const paneId = parts[4];
      const paneActiveStr = parts[5];
      const colsStr = parts[6];
      const rowsStr = parts[7];
      const leftStr = parts[8];
      const topStr = parts[9];
      const pidStr = parts[10];
      const currentCommand = parts[11];
      const sessionActivityStr = parts[12];
      // session_path may contain colons, so rejoin everything after field 13
      const sessionPath = parts.slice(13).join(":");

      const windowIndex = parseInt(windowIndexStr, 10);
      const paneIndex = parseInt(paneIndexStr, 10);
      const active = paneActiveStr === "1";
      const cols = parseInt(colsStr, 10);
      const rows = parseInt(rowsStr, 10);
      const left = parseInt(leftStr, 10);
      const top = parseInt(topStr, 10);
      const pid = parseInt(pidStr, 10);
      const process = getEffectiveProcessFromTable(pid, currentCommand, processTable);
      const sessionActivity = parseInt(sessionActivityStr, 10);

      const target = `${sessionName}:${windowIndex}.${paneIndex}`;

      const pane: TmuxPane = {
        sessionName, windowIndex, windowName, paneIndex, paneId, target,
        active, cols, rows, left, top, pid, process,
      };

      if (!sessions.has(sessionName)) {
        sessions.set(sessionName, { name: sessionName, windows: [], activity: sessionActivity, path: sessionPath || undefined });
      }

      const session = sessions.get(sessionName)!;
      let window = session.windows.find((w) => w.index === windowIndex);
      if (!window) {
        window = { index: windowIndex, name: windowName, panes: [] };
        session.windows.push(window);
      }
      window.panes.push(pane);
    }

    for (const session of sessions.values()) {
      session.windows.sort((a, b) => a.index - b.index);
      for (const window of session.windows) {
        window.panes.sort((a, b) => a.paneIndex - b.paneIndex);
      }
    }

    return Array.from(sessions.values());
  } catch {
    return [];
  }
}

/**
 * Async version of capturePane.
 */
export async function capturePaneAsync(target: string, options: { escape?: boolean; start?: number; end?: number } = {}): Promise<string> {
  const args = ["capture-pane", "-p", "-t", target];
  if (options.escape) args.push("-e");
  if (options.start !== undefined) args.push("-S", options.start.toString());
  if (options.end !== undefined) args.push("-E", options.end.toString());

  const { stdout } = await execFileAsync("tmux", args, { encoding: "utf-8" });
  return stdout;
}

/**
 * Async version of getSessionDimensions.
 */
export async function getSessionDimensionsAsync(sessionName: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["display-message", "-t", sessionName, "-p", "#{window_width}:#{window_height}"],
      { encoding: "utf-8" },
    );
    const [widthStr, heightStr] = stdout.trim().split(":");
    const width = parseInt(widthStr, 10);
    const height = parseInt(heightStr, 10);
    if (isNaN(width) || isNaN(height)) return null;
    return { width, height };
  } catch {
    return null;
  }
}
