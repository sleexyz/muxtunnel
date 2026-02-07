import { execSync, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

const execFileAsync = promisify(execFileCb);

const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || "", ".claude", "projects");

export interface ClaudeSession {
  sessionId: string;
  projectPath: string;
  summary: string;
  firstPrompt: string;
  messageCount: number;
  modified: string;
  status: "thinking" | "done" | "idle";
  notified: boolean;
}

interface SessionsIndex {
  version: number;
  entries: Array<{
    sessionId: string;
    fullPath: string;
    summary: string;
    firstPrompt: string;
    messageCount: number;
    modified: string;
    projectPath: string;
  }>;
}

// Track notification state per session
const notificationState = new Map<string, { notified: boolean; viewedAt: Date | null }>();

// Event emitter for session changes
export const sessionEvents = new EventEmitter();

/**
 * Get the status of a Claude session by reading the last line of its jsonl
 */
function getSessionStatus(jsonlPath: string): "thinking" | "done" | "idle" {
  try {
    if (!fs.existsSync(jsonlPath)) {
      return "idle";
    }

    // Read last few KB of the file to find the last complete line
    const stats = fs.statSync(jsonlPath);
    const readSize = Math.min(stats.size, 10000);
    const fd = fs.openSync(jsonlPath, "r");
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);

    const content = buffer.toString("utf-8");
    const lines = content.split("\n").filter(Boolean);

    if (lines.length === 0) {
      return "idle";
    }

    // Parse the last complete JSON line
    const lastLine = lines[lines.length - 1];
    try {
      const msg = JSON.parse(lastLine);

      // "summary" type means conversation turn is complete
      if (msg.type === "summary") {
        return "done";
      }

      // "user" message means Claude is about to respond — but only if recent.
      // If the file hasn't been modified in over 60s, the session was likely
      // interrupted and Claude is not actually thinking.
      if (msg.type === "user") {
        const mtime = stats.mtimeMs;
        const now = Date.now();
        if (now - mtime < 60000) {
          return "thinking";
        }
        return "done";
      }

      // "assistant" message - check if file was recently modified (still streaming)
      if (msg.type === "assistant") {
        const mtime = stats.mtimeMs;
        const now = Date.now();
        // If modified in last 3 seconds, probably still streaming
        if (now - mtime < 3000) {
          return "thinking";
        }
        return "done";
      }

      return "idle";
    } catch {
      return "idle";
    }
  } catch {
    return "idle";
  }
}

/**
 * Find all Claude sessions for a given project path
 */
export function getSessionsForProject(projectPath: string): ClaudeSession[] {
  try {
    // Convert project path to Claude's directory naming convention
    const projectSlug = projectPath.replace(/\//g, "-");
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectSlug);

    if (!fs.existsSync(projectDir)) {
      return [];
    }

    const indexPath = path.join(projectDir, "sessions-index.json");

    let entries: Array<{ sessionId: string; fullPath: string; summary: string; firstPrompt: string; messageCount: number; modified: string }>;

    if (fs.existsSync(indexPath)) {
      const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      entries = index.entries
        .filter(entry => entry.projectPath === projectPath)
        .map(entry => ({
          sessionId: entry.sessionId,
          fullPath: entry.fullPath,
          summary: entry.summary || "",
          firstPrompt: entry.firstPrompt || "",
          messageCount: entry.messageCount,
          modified: entry.modified,
        }));
    } else {
      // Fallback: scan .jsonl files directly when sessions-index.json is missing
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
      entries = files.map(f => {
        const fullPath = path.join(projectDir, f);
        const sessionId = path.basename(f, ".jsonl");
        const stats = fs.statSync(fullPath);
        return {
          sessionId,
          fullPath,
          summary: "",
          firstPrompt: "",
          messageCount: 0,
          modified: stats.mtime.toISOString(),
        };
      });
    }

    return entries
      .map(entry => {
        // Check and potentially trigger notification
        checkAndNotify(entry.sessionId, entry.fullPath);

        const status = getSessionStatus(entry.fullPath);
        const state = notificationState.get(entry.sessionId) || { notified: false, viewedAt: null };

        return {
          sessionId: entry.sessionId,
          projectPath,
          summary: entry.summary,
          firstPrompt: entry.firstPrompt,
          messageCount: entry.messageCount,
          modified: entry.modified,
          status,
          notified: state.notified,
        };
      })
      .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  } catch (err) {
    console.error("Failed to get Claude sessions:", err);
    return [];
  }
}

/**
 * Get the most recent active Claude session for a project
 */
export function getActiveSession(projectPath: string): ClaudeSession | null {
  const sessions = getSessionsForProject(projectPath);

  // Return the most recently modified session
  return sessions[0] || null;
}

/**
 * Mark a session as viewed (clears notification)
 */
export function markSessionViewed(sessionId: string): void {
  const state = notificationState.get(sessionId) || { notified: false, viewedAt: null };
  state.notified = false;
  state.viewedAt = new Date();
  notificationState.set(sessionId, state);
}

/**
 * Get the working directory from a pane's environment
 */
export function getPaneCwd(paneTarget: string): string | null {
  try {
    const output = execSync(`tmux display-message -t "${paneTarget}" -p "#{pane_current_path}"`, {
      encoding: "utf-8",
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/**
 * Check if a Claude pane is actively processing by detecting orange thinking status
 * Claude Code thinking indicator: [orange]spinner [salmon]Verbing…[/salmon]
 */
export function isPaneProcessing(paneTarget: string): boolean {
  try {
    // Capture last 10 lines with escape sequences
    const output = execSync(`tmux capture-pane -t "${paneTarget}" -p -e -S -10`, {
      encoding: "utf-8",
    });

    // Orange/salmon color range used by Claude Code thinking status
    const thinkingColor = /\x1b\[38;2;(2[0-3][0-9]);(1[0-5][0-9]);([89][0-9]|1[0-2][0-9])m/;

    // Key: thinking status always has ellipsis "…" (distinguishes from "config (0:0)" etc)
    return thinkingColor.test(output) && output.includes("…");
  } catch {
    return false;
  }
}

// ─── Async variants (non-blocking, for polling paths) ───────────────────────

export async function getPaneCwdAsync(paneTarget: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["display-message", "-t", paneTarget, "-p", "#{pane_current_path}"],
      { encoding: "utf-8" },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function isPaneProcessingAsync(paneTarget: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-t", paneTarget, "-p", "-e", "-S", "-10"],
      { encoding: "utf-8" },
    );
    const thinkingColor = /\x1b\[38;2;(2[0-3][0-9]);(1[0-5][0-9]);([89][0-9]|1[0-2][0-9])m/;
    return thinkingColor.test(stdout) && stdout.includes("…");
  } catch {
    return false;
  }
}

// Track previous status for change detection
const previousStatus = new Map<string, string>();

/**
 * Check if a session should trigger a notification
 * This is called both on file change and when first accessing a session
 */
function checkAndNotify(sessionId: string, fullPath: string): void {
  const status = getSessionStatus(fullPath);
  const prevStatus = previousStatus.get(sessionId);
  const state = notificationState.get(sessionId) || { notified: false, viewedAt: null };

  // Reset viewedAt when a new turn starts (status leaves "done")
  if (prevStatus === "done" && status !== "done") {
    state.viewedAt = null;
  }

  // Detect transition to "done"
  if (prevStatus === "thinking" && status === "done") {
    console.log(`Claude session ${sessionId} completed`);
    state.notified = true;
    notificationState.set(sessionId, state);
    sessionEvents.emit("completed", sessionId);
  }

  // Also notify if session is "done" and hasn't been notified yet
  // (handles case where server starts after Claude finished)
  // But don't re-notify if user already viewed it while in "done" state
  if (status === "done" && !state.notified && !state.viewedAt) {
    console.log(`Claude session ${sessionId} needs attention (done)`);
    state.notified = true;
    notificationState.set(sessionId, state);
  }

  previousStatus.set(sessionId, status);
}

/**
 * Start watching for Claude session changes
 */
export function startWatching(): void {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    console.log("Claude projects directory not found, skipping session watching");
    return;
  }

  console.log("Watching Claude sessions at:", CLAUDE_PROJECTS_DIR);

  // Watch for file changes
  fs.watch(CLAUDE_PROJECTS_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename || !filename.endsWith(".jsonl")) {
      return;
    }

    // Extract session ID from filename
    const sessionId = path.basename(filename, ".jsonl");
    const fullPath = path.join(CLAUDE_PROJECTS_DIR, filename);

    checkAndNotify(sessionId, fullPath);
  });
}
