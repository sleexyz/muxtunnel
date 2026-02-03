import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

// Note: FitAddon removed - terminal size is fixed to session dimensions

interface TmuxPane {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  paneId: string;
  target: string;
  active: boolean;
  cols: number;
  rows: number;
  // Geometry for cropping (0-indexed, in character units)
  left: number;
  top: number;
  // Process info
  pid: number;
  process: string;
  needsAttention?: boolean;
  attentionReason?: string;
}

interface TmuxWindow {
  index: number;
  name: string;
  panes: TmuxPane[];
}

interface TmuxSession {
  name: string;
  windows: TmuxWindow[];
  dimensions?: { width: number; height: number };
}

let terminal: Terminal | null = null;
let ws: WebSocket | null = null;
let currentPane: string | null = null;
let currentSession: string | null = null;
let sessionsRefreshInterval: number | null = null;
let sessionsData: TmuxSession[] = [];
let cellDimensions: { width: number; height: number } | null = null;

// DOM elements
const sessionsList = document.getElementById("sessions-list")!;
const terminalContainer = document.getElementById("terminal")!;
const cropContainer = document.getElementById("crop-container")!;
const terminalPositioner = document.getElementById("terminal-positioner")!;

/**
 * Fetch sessions from the API
 */
async function fetchSessions(): Promise<TmuxSession[]> {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) throw new Error("Failed to fetch sessions");
    return await res.json();
  } catch (err) {
    console.error("Failed to fetch sessions:", err);
    return [];
  }
}

/**
 * Render the sessions list in the sidebar
 * Uses event delegation to avoid handler duplication issues
 */
function renderSessionsList(sessions: TmuxSession[]) {
  if (sessions.length === 0) {
    sessionsList.innerHTML = `
      <div style="color: #888; padding: 12px; font-size: 13px;">
        No tmux sessions found.<br><br>
        Start tmux and create a session to get started.
      </div>
    `;
    return;
  }

  let html = "";

  for (const session of sessions) {
    const isSessionSelected = currentSession === session.name && currentPane === null;
    html += `<div class="session-group">`;
    html += `<div class="session-name clickable ${isSessionSelected ? "selected" : ""}" data-session="${escapeHtml(session.name)}">${escapeHtml(session.name)}</div>`;

    for (const window of session.windows) {
      for (const pane of window.panes) {
        const isSelected = pane.target === currentPane;
        const hasAttention = pane.needsAttention;
        const processName = pane.process || "";

        html += `
          <div class="pane-item ${isSelected ? "selected" : ""}" data-target="${escapeHtml(pane.target)}">
            <span class="pane-info">
              <span class="pane-id">${window.index}:${pane.paneIndex}</span>
              <span class="pane-process">${escapeHtml(processName)}</span>
            </span>
            <span class="pane-actions">
              ${hasAttention ? `<span class="attention-badge">!</span>` : ""}
              <span class="close-btn" data-close="${escapeHtml(pane.target)}">&times;</span>
            </span>
          </div>
        `;
      }
    }

    html += `</div>`;
  }

  sessionsList.innerHTML = html;
  // Note: Click handling is done via event delegation in setupEventDelegation()
}

/**
 * Setup event delegation for sidebar clicks (called once at init)
 */
function setupEventDelegation() {
  sessionsList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    // Handle close button clicks
    const closeBtn = target.closest(".close-btn");
    if (closeBtn) {
      const paneTarget = closeBtn.getAttribute("data-close");
      if (paneTarget) {
        closePane(paneTarget);
      }
      return;
    }

    // Handle session name clicks (full session view)
    const sessionName = target.closest(".session-name");
    if (sessionName) {
      const session = sessionName.getAttribute("data-session");
      if (session) {
        selectSession(session);
      }
      return;
    }

    // Handle pane item clicks
    const paneItem = target.closest(".pane-item");
    if (paneItem) {
      const paneTarget = paneItem.getAttribute("data-target");
      if (paneTarget && paneTarget !== currentPane) {
        selectPane(paneTarget);
      }
    }
  });
}

/**
 * Escape HTML entities
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Initialize or reset the terminal with fixed session dimensions
 * @param sessionName - name of the session to get dimensions from
 */
function initTerminal(sessionName: string) {
  // Get session dimensions
  const session = sessionsData.find(s => s.name === sessionName);
  if (!session?.dimensions) {
    console.error(`No dimensions for session ${sessionName}`);
    return;
  }

  const { width: cols, height: rows } = session.dimensions;

  // Clear existing terminal
  if (terminal) {
    terminal.dispose();
  }
  terminalContainer.innerHTML = "";

  // Create terminal at FIXED session size (no FitAddon!)
  terminal = new Terminal({
    cols,
    rows,
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#d4d4d4",
      selectionBackground: "#264f78",
    },
  });

  // Try WebGL addon for better performance
  try {
    terminal.loadAddon(new WebglAddon());
  } catch (e) {
    console.warn("WebGL not available:", e);
  }

  terminal.open(terminalContainer);

  // Set explicit dimensions on the terminal container to prevent xterm.js
  // from being constrained by the crop-container's smaller size.
  // This is calculated after the terminal is opened so we have cell dimensions.
  requestAnimationFrame(() => {
    if (terminal) {
      const core = (terminal as any)._core;
      if (core?._renderService?.dimensions?.css?.cell) {
        const dims = core._renderService.dimensions.css.cell;
        const fullWidth = cols * dims.width;
        const fullHeight = rows * dims.height;
        terminalContainer.style.width = `${fullWidth}px`;
        terminalContainer.style.height = `${fullHeight}px`;
        terminalPositioner.style.width = `${fullWidth}px`;
        terminalPositioner.style.height = `${fullHeight}px`;
      }
    }
  });

  // Capture cell dimensions after render
  requestAnimationFrame(() => {
    if (terminal) {
      const core = (terminal as any)._core;
      if (core?._renderService?.dimensions?.css?.cell) {
        const dims = core._renderService.dimensions.css.cell;
        cellDimensions = { width: dims.width, height: dims.height };
        // Apply appropriate view based on selection
        if (currentPane) {
          applyCropForPane(currentPane);
        } else {
          showFullSession(sessionName);
        }
      }
    }
  });

  // Handle user input
  terminal.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // With CSS cropping, mouse coordinates are already in session-relative coordinates
      // (the terminal canvas is full session size, CSS just crops the view)
      // No translation needed!
      ws.send(JSON.stringify({ type: "keys", keys: data }));
    }
  });
}

/**
 * Find a pane by target in the sessions data
 */
function findPane(target: string): TmuxPane | null {
  for (const session of sessionsData) {
    for (const window of session.windows) {
      for (const pane of window.panes) {
        if (pane.target === target) {
          return pane;
        }
      }
    }
  }
  return null;
}

/**
 * Apply crop to show only the selected pane
 * @param target - pane target (e.g., "session:0.0")
 */
function applyCropForPane(target: string) {
  if (!cellDimensions) {
    return;
  }

  const pane = findPane(target);
  if (!pane) {
    console.warn(`Pane ${target} not found in sessions data`);
    return;
  }

  // tmux pane_left/pane_top already point to where content starts (after any borders)
  const effectiveLeft = pane.left;
  const effectiveTop = pane.top;

  // Set container size to match pane dimensions (in pixels)
  cropContainer.style.width = `${pane.cols * cellDimensions.width}px`;
  cropContainer.style.height = `${pane.rows * cellDimensions.height}px`;

  // Translate the terminal to show the correct region
  terminalPositioner.style.transform = `translate(${-effectiveLeft * cellDimensions.width}px, ${-effectiveTop * cellDimensions.height}px)`;
}

/**
 * Connect to a session via WebSocket with PTY attachment
 * Uses session dimensions to create PTY at full session size
 */
function connectToSession(sessionName: string, initialPaneTarget: string) {
  // Close existing connection
  if (ws) {
    ws.close();
    ws = null;
  }

  // Get session dimensions
  const session = sessionsData.find(s => s.name === sessionName);
  if (!session?.dimensions) {
    console.error(`No dimensions for session ${sessionName}`);
    return;
  }

  const { width: cols, height: rows } = session.dimensions;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Connect to the session (using any pane target in that session)
  const wsUrl = `${protocol}//${window.location.host}/ws?pane=${encodeURIComponent(initialPaneTarget)}&cols=${cols}&rows=${rows}`;

  // Use binary type for efficient PTY data transfer
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    // Connected
  };

  ws.onmessage = (event) => {
    // Handle binary PTY data
    if (event.data instanceof ArrayBuffer) {
      if (terminal) {
        const data = new Uint8Array(event.data);
        terminal.write(data);
      }
      return;
    }

    // Handle JSON control messages
    try {
      JSON.parse(event.data);
      // Control messages handled here if needed
    } catch {
      // If not JSON and not binary, try writing as text
      if (terminal && typeof event.data === "string") {
        terminal.write(event.data);
      }
    }
  };

  ws.onclose = () => {
    if (terminal) {
      terminal.write("\r\n\x1b[31m[Connection closed]\x1b[0m\r\n");
    }
    // Note: Don't reset currentSession here - it's set in connectToSession
    // and we don't want an intentional disconnect (for switching sessions)
    // to reset it prematurely
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  currentSession = sessionName;
}

/**
 * Select a pane to view
 * Only reconnects PTY when switching to a different SESSION
 * Pane switching within same session is CSS-only (instant)
 */
function selectPane(target: string) {
  const pane = findPane(target);
  if (!pane) {
    console.error(`Pane ${target} not found`);
    return;
  }

  const newSessionName = pane.sessionName;
  const needsReconnect = currentSession !== newSessionName;

  currentPane = target;

  // Update UI
  sessionsList.querySelectorAll(".pane-item").forEach((el) => {
    el.classList.toggle("selected", el.getAttribute("data-target") === target);
  });

  if (needsReconnect) {
    // Different session - need to reconnect
    initTerminal(newSessionName);
    connectToSession(newSessionName, target);
  } else {
    // Same session - just update CSS crop (instant!)
    applyCropForPane(target);
  }

  // Note: Input goes to whichever pane tmux has active.
  // User can switch active pane using tmux prefix + arrow keys.
  // Future: could add API to sync pane focus via tmux select-pane
}

/**
 * Select a session to view full tiled view (no pane cropping)
 */
function selectSession(sessionName: string) {
  const session = sessionsData.find(s => s.name === sessionName);
  if (!session) {
    console.error(`Session ${sessionName} not found`);
    return;
  }

  const needsReconnect = currentSession !== sessionName;
  currentPane = null; // No specific pane selected

  // Update UI - highlight session name, remove pane selection
  sessionsList.querySelectorAll(".pane-item").forEach((el) => {
    el.classList.remove("selected");
  });
  sessionsList.querySelectorAll(".session-name").forEach((el) => {
    el.classList.toggle("selected", el.getAttribute("data-session") === sessionName);
  });

  if (needsReconnect) {
    // Different session - need to reconnect
    initTerminal(sessionName);
    // Use first pane as connection target (needed for PTY)
    const firstPane = session.windows[0]?.panes[0];
    if (firstPane) {
      connectToSession(sessionName, firstPane.target);
    }
  }

  // Show full session (no cropping)
  showFullSession(sessionName);
}

/**
 * Show full session view (no cropping)
 */
function showFullSession(sessionName: string) {
  if (!cellDimensions) {
    return;
  }

  const session = sessionsData.find(s => s.name === sessionName);
  if (!session?.dimensions) {
    return;
  }

  const { width, height } = session.dimensions;

  // Set container to full session size
  cropContainer.style.width = `${width * cellDimensions.width}px`;
  cropContainer.style.height = `${height * cellDimensions.height}px`;

  // No transform needed - show from origin
  terminalPositioner.style.transform = "translate(0, 0)";
}

/**
 * Close a pane via API
 */
async function closePane(target: string) {
  try {
    const res = await fetch(`/api/panes/${encodeURIComponent(target)}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const data = await res.json();
      console.error("Failed to close pane:", data.error);
      return;
    }

    // If we closed the currently selected pane, clear selection
    if (currentPane === target) {
      currentPane = null;
      // Could auto-select another pane here
    }

    // Refresh sessions list
    await refreshSessions();
  } catch (err) {
    console.error("Failed to close pane:", err);
  }
}

/**
 * Refresh sessions list periodically
 */
async function refreshSessions() {
  const sessions = await fetchSessions();
  sessionsData = sessions;
  renderSessionsList(sessions);
}

/**
 * Initialize the app
 */
async function init() {
  // Setup event delegation (once)
  setupEventDelegation();

  // Initial fetch
  await refreshSessions();

  // Start periodic refresh (every 2 seconds for attention detection)
  sessionsRefreshInterval = window.setInterval(refreshSessions, 2000);
}

// Start the app
init();
