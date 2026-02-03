import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

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

      if (msg.type === "user") {
        // User message means Claude is processing or waiting for tool result
        return "thinking";
      }

      if (msg.type === "assistant") {
        // Check stop_reason
        const stopReason = msg.message?.stop_reason;
        if (stopReason === null || stopReason === undefined) {
          return "thinking"; // Still streaming
        }
        return "done"; // Completed response
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
    if (!fs.existsSync(indexPath)) {
      return [];
    }

    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));

    return index.entries
      .filter(entry => entry.projectPath === projectPath)
      .map(entry => {
        const status = getSessionStatus(entry.fullPath);
        const state = notificationState.get(entry.sessionId) || { notified: false, viewedAt: null };

        return {
          sessionId: entry.sessionId,
          projectPath: entry.projectPath,
          summary: entry.summary || "",
          firstPrompt: entry.firstPrompt || "",
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

// Track previous status for change detection
const previousStatus = new Map<string, string>();

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

    // Check status
    const status = getSessionStatus(fullPath);
    const prevStatus = previousStatus.get(sessionId);

    // Detect transition to "done"
    if (prevStatus === "thinking" && status === "done") {
      console.log(`Claude session ${sessionId} completed`);

      // Set notification flag
      const state = notificationState.get(sessionId) || { notified: false, viewedAt: null };
      state.notified = true;
      notificationState.set(sessionId, state);

      // Emit event
      sessionEvents.emit("completed", sessionId);
    }

    previousStatus.set(sessionId, status);
  });
}
