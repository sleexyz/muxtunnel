import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { listSessions, capturePane, capturePaneWithEscapes, sendKeys, resizePane, getPaneInfo, isTmuxRunning } from "./tmux.js";
import { detectAttention } from "./attention.js";

const PORT = parseInt(process.env.PORT || "3002", 10);
const HOST = process.env.HOST || "localhost";
const STATIC_DIR = process.env.STATIC_DIR || path.join(import.meta.dirname, "..", "dist", "client");
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "100", 10);

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Get sessions with attention state
 */
function getSessionsWithAttention() {
  const sessions = listSessions();

  // Add attention detection to each pane
  for (const session of sessions) {
    for (const window of session.windows) {
      for (const pane of window.panes) {
        try {
          const content = capturePane(pane.target);
          const attention = detectAttention(content);
          (pane as any).needsAttention = attention.needsAttention;
          (pane as any).attentionReason = attention.reason;
        } catch {
          (pane as any).needsAttention = false;
        }
      }
    }
  }

  return sessions;
}

/**
 * Serve static files from dist/client
 */
function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  let urlPath = req.url?.split("?")[0] || "/";

  // Prevent directory traversal
  urlPath = urlPath.replace(/\.\./g, "");

  if (urlPath === "/") {
    urlPath = "/index.html";
  }

  const filePath = path.join(STATIC_DIR, urlPath);

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback - serve index.html for non-file routes
    if (!urlPath.includes(".")) {
      const indexPath = path.join(STATIC_DIR, "index.html");
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
        return true;
      }
    }
    return false;
  }

  const ext = path.extname(filePath);
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": mimeType });
  res.end(content);
  return true;
}

// Create HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API endpoints
  if (url.pathname === "/api/sessions") {
    const sessions = getSessionsWithAttention();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sessions));
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "muxtunnel",
      tmuxRunning: isTmuxRunning(),
    }));
    return;
  }

  // Serve static files
  if (serveStaticFile(req, res)) {
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Track active pane connections
const paneConnections = new Map<string, {
  ws: WebSocket;
  pollInterval: NodeJS.Timeout;
  lastContent: string;
}>();

// Handle WebSocket connections
wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const paneTarget = url.searchParams.get("pane");

  if (!paneTarget) {
    ws.close(4000, "Missing pane parameter");
    return;
  }

  console.log(`[WS] Client connected for pane: ${paneTarget}`);

  // Get initial pane info
  const paneInfo = getPaneInfo(paneTarget);
  if (!paneInfo) {
    ws.close(4001, "Pane not found");
    return;
  }

  // Send initial pane info
  ws.send(JSON.stringify({
    type: "pane-info",
    pane: paneInfo,
  }));

  let lastContent = "";

  // Start polling for pane content
  const pollInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(pollInterval);
      return;
    }

    try {
      // Capture with escape codes for xterm.js rendering
      const content = capturePaneWithEscapes(paneTarget);

      // Only send if content changed
      if (content !== lastContent) {
        lastContent = content;

        // Also check attention state
        const plainContent = capturePane(paneTarget);
        const attention = detectAttention(plainContent);

        ws.send(JSON.stringify({
          type: "content",
          content,
          needsAttention: attention.needsAttention,
          attentionReason: attention.reason,
        }));
      }
    } catch (err) {
      console.error(`[WS] Error capturing pane ${paneTarget}:`, err);
    }
  }, POLL_INTERVAL);

  // Handle incoming messages (keystrokes and control messages)
  ws.on("message", (data: Buffer) => {
    const message = data.toString();

    // Check if it's a JSON control message
    if (message.startsWith("{")) {
      try {
        const parsed = JSON.parse(message);

        if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
          resizePane(paneTarget, parsed.cols, parsed.rows);
          return;
        }

        if (parsed.type === "keys" && typeof parsed.keys === "string") {
          // Send literal keys (for text input)
          sendKeys(paneTarget, parsed.keys, true);
          return;
        }

        if (parsed.type === "special" && typeof parsed.key === "string") {
          // Send special keys (Enter, Escape, etc.)
          sendKeys(paneTarget, parsed.key, false);
          return;
        }
      } catch {
        // Not valid JSON, treat as raw input
      }
    }

    // Raw input - send as literal text
    sendKeys(paneTarget, message, true);
  });

  // Cleanup on close
  ws.on("close", () => {
    console.log(`[WS] Client disconnected for pane: ${paneTarget}`);
    clearInterval(pollInterval);
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error for pane ${paneTarget}:`, err);
    clearInterval(pollInterval);
  });
});

// Handle HTTP upgrade for WebSocket
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Start server
server.listen(PORT, HOST, () => {
  console.log(`MuxTunnel server running at http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws?pane=SESSION:WINDOW.PANE`);
  console.log(`API endpoint: http://${HOST}:${PORT}/api/sessions`);

  if (!isTmuxRunning()) {
    console.warn("\n⚠️  tmux is not running! Start tmux to use MuxTunnel.\n");
  }
});
