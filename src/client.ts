import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

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
}

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ws: WebSocket | null = null;
let currentPane: string | null = null;
let sessionsRefreshInterval: number | null = null;
let sessionsData: TmuxSession[] = [];
let cellDimensions: { width: number; height: number } | null = null;

// DOM elements
const sessionsList = document.getElementById("sessions-list")!;
const terminalContainer = document.getElementById("terminal")!;
const terminalHeader = document.getElementById("terminal-header")!;
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
    html += `<div class="session-group">`;
    html += `<div class="session-name">${escapeHtml(session.name)}</div>`;

    for (const window of session.windows) {
      for (const pane of window.panes) {
        const isSelected = pane.target === currentPane;
        const hasAttention = pane.needsAttention;

        html += `
          <div class="pane-item ${isSelected ? "selected" : ""}" data-target="${escapeHtml(pane.target)}">
            <span class="pane-id">${window.index}:${pane.paneIndex}</span>
            ${hasAttention ? `<span class="attention-badge">!</span>` : ""}
          </div>
        `;
      }
    }

    html += `</div>`;
  }

  sessionsList.innerHTML = html;

  // Add click handlers
  sessionsList.querySelectorAll(".pane-item").forEach((el) => {
    el.addEventListener("click", () => {
      const target = el.getAttribute("data-target");
      if (target && target !== currentPane) {
        selectPane(target);
      }
    });
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
 * Initialize or reset the terminal
 */
function initTerminal() {
  // Clear existing terminal
  if (terminal) {
    terminal.dispose();
  }
  terminalContainer.innerHTML = "";

  terminal = new Terminal({
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

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Try WebGL addon for better performance
  try {
    terminal.loadAddon(new WebglAddon());
  } catch (e) {
    console.warn("WebGL not available:", e);
  }

  terminal.open(terminalContainer);
  fitAddon.fit();

  // Capture cell dimensions after render (accessing private API as FitAddon does)
  // Use requestAnimationFrame to ensure render is complete
  requestAnimationFrame(() => {
    if (terminal) {
      const core = (terminal as any)._core;
      if (core?._renderService?.dimensions?.css?.cell) {
        const dims = core._renderService.dimensions.css.cell;
        cellDimensions = { width: dims.width, height: dims.height };
        console.log("Cell dimensions:", cellDimensions);
        // If we have a current pane, apply crop now that we have dimensions
        if (currentPane) {
          applyCropForPane(currentPane);
        }
      }
    }
  });

  // Handle window resize
  window.addEventListener("resize", () => {
    if (fitAddon) {
      fitAddon.fit();
      // Re-capture cell dimensions after resize
      if (terminal) {
        const core = (terminal as any)._core;
        if (core?._renderService?.dimensions?.css?.cell) {
          const dims = core._renderService.dimensions.css.cell;
          cellDimensions = { width: dims.width, height: dims.height };
          // Re-apply crop with new dimensions
          if (currentPane) {
            applyCropForPane(currentPane);
          }
        }
      }
      // Send resize to server
      if (ws && ws.readyState === WebSocket.OPEN && terminal) {
        ws.send(JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        }));
      }
    }
  });

  // Handle user input
  terminal.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send as literal keys
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
    console.log("Cell dimensions not available yet, skipping crop");
    return;
  }

  const pane = findPane(target);
  if (!pane) {
    console.warn(`Pane ${target} not found in sessions data`);
    return;
  }

  // Account for border offset: panes not at edge have a 1-char border to their left/top
  const borderLeftOffset = pane.left > 0 ? 1 : 0;
  const borderTopOffset = pane.top > 0 ? 1 : 0;
  const effectiveLeft = pane.left + borderLeftOffset;
  const effectiveTop = pane.top + borderTopOffset;

  // Set container size to match pane dimensions (in pixels)
  cropContainer.style.width = `${pane.cols * cellDimensions.width}px`;
  cropContainer.style.height = `${pane.rows * cellDimensions.height}px`;

  // Translate the terminal to show the correct region
  terminalPositioner.style.transform = `translate(${-effectiveLeft * cellDimensions.width}px, ${-effectiveTop * cellDimensions.height}px)`;

  console.log(`Crop applied: pane=${target}, left=${effectiveLeft}, top=${effectiveTop}, size=${pane.cols}x${pane.rows}`);
}

/**
 * Connect to a pane via WebSocket with PTY attachment
 */
function connectToPane(target: string) {
  // Close existing connection
  if (ws) {
    ws.close();
    ws = null;
  }

  // Get terminal dimensions for PTY creation
  let cols = 80;
  let rows = 24;
  if (terminal && fitAddon) {
    fitAddon.fit();
    cols = terminal.cols;
    rows = terminal.rows;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws?pane=${encodeURIComponent(target)}&cols=${cols}&rows=${rows}`;

  // Use binary type for efficient PTY data transfer
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log(`Connected to pane: ${target} (${cols}x${rows})`);
    terminalHeader.textContent = target;
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
      const data = JSON.parse(event.data);

      if (data.type === "pane-info") {
        console.log("Pane info:", data.pane);
      }
    } catch {
      // If not JSON and not binary, try writing as text
      if (terminal && typeof event.data === "string") {
        terminal.write(event.data);
      }
    }
  };

  ws.onclose = (event) => {
    console.log(`Disconnected from pane: ${target}`, event.code, event.reason);
    if (terminal) {
      terminal.write("\r\n\x1b[31m[Connection closed]\x1b[0m\r\n");
    }
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };
}

/**
 * Select a pane to view
 */
function selectPane(target: string) {
  currentPane = target;

  // Update UI
  sessionsList.querySelectorAll(".pane-item").forEach((el) => {
    el.classList.toggle("selected", el.getAttribute("data-target") === target);
  });

  terminalHeader.textContent = target;

  // Initialize terminal if needed, or clear for new connection
  if (!terminal) {
    initTerminal();
  } else {
    // Clear terminal for new PTY connection
    terminal.clear();
    // Apply crop for the selected pane
    applyCropForPane(target);
  }

  // Connect to the pane
  connectToPane(target);
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
  // Initial fetch
  await refreshSessions();

  // Start periodic refresh (every 2 seconds for attention detection)
  sessionsRefreshInterval = window.setInterval(refreshSessions, 2000);
}

// Start the app
init();
