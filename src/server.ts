import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execSync, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import { getPaneInfo, isTmuxRunning, killPane, killSession, listSessionsAsync, getSessionDimensionsAsync, createSessionAsync } from "./tmux.js";

const execFileAsync = promisify(execFileCb);
import { createPtySession, PtySession } from "./pty.js";
import { getActiveSession, markSessionViewed, startWatching as startClaudeWatching, getPaneCwdAsync, isPaneProcessingAsync } from "./claude-sessions.js";
import { getSettings, getBackgroundImagePath, startSettingsWatching } from "./settings.js";
import { getSessionOrder, saveSessionOrder, loadSessionOrder } from "./session-order.js";

const PORT = parseInt(process.env.PORT || "3002", 10);
const HOST = process.env.HOST || "localhost";
const STATIC_DIR = process.env.STATIC_DIR || path.join(import.meta.dirname, "..", "dist", "client");

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
 * Get sessions with attention state, dimensions, and Claude session info.
 * Fully async — never blocks the event loop, so WebSocket I/O stays responsive.
 */
async function getSessionsWithAttention() {
  const sessions = await listSessionsAsync();

  // Fetch all session dimensions in parallel
  await Promise.all(sessions.map(async (session) => {
    const dimensions = await getSessionDimensionsAsync(session.name);
    if (dimensions) {
      (session as any).dimensions = dimensions;
    }
  }));

  // Process all panes in parallel (capture + attention + Claude status)
  const paneJobs: Promise<void>[] = [];
  for (const session of sessions) {
    for (const window of session.windows) {
      for (const pane of window.panes) {
        paneJobs.push((async () => {
          if (pane.process === "claude") {
            const cwd = await getPaneCwdAsync(pane.target);
            if (cwd) {
              const claudeSession = getActiveSession(cwd);
              if (claudeSession) {
                if (await isPaneProcessingAsync(pane.target)) {
                  claudeSession.status = "thinking";
                }
                (pane as any).claudeSession = claudeSession;
              }
            }
          }
        })());
      }
    }
  }
  await Promise.all(paneJobs);

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API endpoints
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    getSessionsWithAttention().then((sessions) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions));
    }).catch((err) => {
      console.error("Failed to get sessions:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to get sessions" }));
    });
    return;
  }

  if (url.pathname === "/api/sessions" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { name, cwd } = JSON.parse(body);
        if (typeof name !== "string" || typeof cwd !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "name and cwd are required" }));
          return;
        }
        await createSessionAsync(name, cwd);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (url.pathname === "/api/zoxide" && req.method === "GET") {
    execFileAsync("zoxide", ["query", "--list", "--score"], { encoding: "utf-8" }).then(({ stdout }) => {
      const entries = stdout.trim().split("\n").filter(Boolean).map((line) => {
        const match = line.trim().match(/^\s*([\d.]+)\s+(.+)$/);
        if (!match) return null;
        const score = parseFloat(match[1]);
        const fullPath = match[2];
        const name = path.basename(fullPath);
        return { score, path: fullPath, name };
      }).filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entries));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  // GET /api/zoxide/:name - resolve a single name via zoxide query
  const zoxideNameMatch = url.pathname.match(/^\/api\/zoxide\/([^/]+)$/);
  if (zoxideNameMatch && req.method === "GET") {
    const name = decodeURIComponent(zoxideNameMatch[1]);
    execFileAsync("zoxide", ["query", name], { encoding: "utf-8" }).then(({ stdout }) => {
      const resolvedPath = stdout.trim();
      if (!resolvedPath) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No match" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: resolvedPath, name: path.basename(resolvedPath) }));
    }).catch(() => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No zoxide match" }));
    });
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

  if (url.pathname === "/api/settings") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getSettings()));
    return;
  }

  if (url.pathname === "/api/settings/background") {
    const imagePath = getBackgroundImagePath();
    if (!imagePath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No local background image configured" }));
      return;
    }
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";
    try {
      const data = fs.readFileSync(imagePath);
      res.writeHead(200, { "Content-Type": mimeType });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to read background image" }));
    }
    return;
  }

  if (url.pathname === "/api/session-order" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getSessionOrder()));
    return;
  }

  if (url.pathname === "/api/session-order" && req.method === "PUT") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed) || !parsed.every((s: unknown) => typeof s === "string")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Expected array of strings" }));
          return;
        }
        saveSessionOrder(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // DELETE /api/sessions/:name - kill a session
  const sessionDeleteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionDeleteMatch && req.method === "DELETE") {
    const name = decodeURIComponent(sessionDeleteMatch[1]);
    try {
      killSession(name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // DELETE /api/panes/:target - kill a pane
  const paneDeleteMatch = url.pathname.match(/^\/api\/panes\/([^/]+)$/);
  if (paneDeleteMatch && req.method === "DELETE") {
    const target = decodeURIComponent(paneDeleteMatch[1]);
    try {
      killPane(target);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // POST /api/panes/:target/input - send text input to pane
  const paneInputMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/input$/);
  if (paneInputMatch && req.method === "POST") {
    const target = decodeURIComponent(paneInputMatch[1]);
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { text } = JSON.parse(body);
        if (typeof text !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "text is required" }));
          return;
        }
        // Send keys to tmux pane
        execSync(`tmux send-keys -t ${JSON.stringify(target)} -l ${JSON.stringify(text)}`);
        execSync(`tmux send-keys -t ${JSON.stringify(target)} Enter`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // POST /api/panes/:target/interrupt - send Ctrl+C to pane
  const paneInterruptMatch = url.pathname.match(/^\/api\/panes\/([^/]+)\/interrupt$/);
  if (paneInterruptMatch && req.method === "POST") {
    const target = decodeURIComponent(paneInterruptMatch[1]);
    try {
      execSync(`tmux send-keys -t ${JSON.stringify(target)} C-c`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // POST /api/claude-sessions/:id/viewed - mark session as viewed
  const claudeMatch = url.pathname.match(/^\/api\/claude-sessions\/([^/]+)\/viewed$/);
  if (claudeMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(claudeMatch[1]);
    markSessionViewed(sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Internal endpoint: tmux hook notifies us when a client switches sessions
  if (url.pathname === "/api/internal/session-changed" && req.method === "GET") {
    const pid = parseInt(url.searchParams.get("pid") || "", 10);
    const session = url.searchParams.get("session");
    if (!pid || !session) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "pid and session required" }));
      return;
    }
    const ws = pidToWs.get(pid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "session-changed", session }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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

// Track active PTY sessions per WebSocket connection
const activeSessions = new Map<WebSocket, PtySession>();

// Map child PID → WebSocket for session-changed hook notifications
const pidToWs = new Map<number, WebSocket>();

// Heartbeat to detect dead connections and prevent proxy/OS idle timeouts
const PING_INTERVAL_MS = 30_000;
const wsAlive = new Map<WebSocket, boolean>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (wsAlive.get(ws) === false) {
      console.log("[WS] Terminating unresponsive client");
      ws.terminate();
      continue;
    }
    wsAlive.set(ws, false);
    ws.ping();
  }
}, PING_INTERVAL_MS);

// Handle WebSocket connections
wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const paneTarget = url.searchParams.get("pane");
  const cols = parseInt(url.searchParams.get("cols") || "80", 10);
  const rows = parseInt(url.searchParams.get("rows") || "24", 10);

  if (!paneTarget) {
    ws.close(4000, "Missing pane parameter");
    return;
  }

  console.log(`[WS] Client connected for pane: ${paneTarget} (${cols}x${rows})`);

  // Heartbeat tracking
  wsAlive.set(ws, true);
  ws.on("pong", () => { wsAlive.set(ws, true); });

  // Get initial pane info to verify it exists
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

  // Create PTY session attached to the tmux pane
  let ptySession: PtySession;
  try {
    ptySession = createPtySession({
      target: paneTarget,
      cols,
      rows,
    });
    activeSessions.set(ws, ptySession);
    pidToWs.set(ptySession.pid, ws);
    console.log(`[WS] PTY session created for pane: ${paneTarget} (pid: ${ptySession.pid})`);
  } catch (err) {
    console.error(`[WS] Failed to create PTY for pane ${paneTarget}:`, err);
    ws.close(4002, "Failed to create PTY session");
    return;
  }

  // Forward PTY output to WebSocket as binary data
  ptySession.on("data", (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      // Send as binary for efficiency - xterm.js handles raw terminal data
      ws.send(data);
    }
  });

  ptySession.on("exit", (exitCode, signal) => {
    console.log(`[WS] PTY exited for pane ${paneTarget} (code: ${exitCode}, signal: ${signal})`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "PTY exited");
    }
  });

  ptySession.on("error", (err) => {
    console.error(`[WS] PTY error for pane ${paneTarget}:`, err);
  });

  ptySession.on("end", () => {
    console.log(`[WS] PTY stream ended for pane ${paneTarget}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "PTY stream ended");
    }
  });

  // Handle incoming messages (keystrokes and control messages)
  ws.on("message", (data: Buffer) => {
    const message = data.toString();

    // Check if it's a JSON control message
    if (message.startsWith("{")) {
      try {
        const parsed = JSON.parse(message);

        if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
          console.log(`[WS] Resizing PTY for ${paneTarget} to ${parsed.cols}x${parsed.rows}`);
          ptySession.resize(parsed.cols, parsed.rows);
          return;
        }

        // For keys messages, write directly to PTY
        if (parsed.type === "keys" && typeof parsed.keys === "string") {
          ptySession.write(parsed.keys);
          return;
        }
      } catch {
        // Not valid JSON, treat as raw input
      }
    }

    // Raw input - write directly to PTY
    ptySession.write(message);
  });

  // Cleanup on close
  ws.on("close", (code: number, reason: Buffer) => {
    console.log(`[WS] Client disconnected for pane: ${paneTarget} (code: ${code}, reason: ${reason.toString() || "none"})`);
    wsAlive.delete(ws);
    const session = activeSessions.get(ws);
    if (session) {
      pidToWs.delete(session.pid);
      session.close();
      activeSessions.delete(ws);
    }
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error for pane ${paneTarget}:`, err);
    wsAlive.delete(ws);
    const session = activeSessions.get(ws);
    if (session) {
      pidToWs.delete(session.pid);
      session.close();
      activeSessions.delete(ws);
    }
  });
});

// Handle HTTP upgrade for WebSocket
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/ws") {
    // Disable Nagle's algorithm — critical for low-latency interactive I/O.
    // Without this, small keystroke packets can be delayed 40-200ms by Nagle + delayed ACK.
    if (socket instanceof net.Socket) {
      socket.setNoDelay(true);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Start Claude session watching
startClaudeWatching();

// Start settings file watching
startSettingsWatching();

// Load session order
loadSessionOrder();

// Install tmux hook to detect session switches and clean up on exit
function installTmuxHook() {
  try {
    const hookCmd = `run-shell "curl -s \\"http://${HOST}:${PORT}/api/internal/session-changed?pid=#{client_pid}&session=#{session_name}\\" &"`;
    execSync(`tmux set-hook -g 'client-session-changed[999]' '${hookCmd}'`);
    console.log("[tmux] Installed client-session-changed hook");
  } catch (err) {
    console.warn("[tmux] Failed to install session-changed hook:", err);
  }
}

function removeTmuxHook() {
  try {
    execSync("tmux set-hook -gu 'client-session-changed[999]'");
    console.log("[tmux] Removed client-session-changed hook");
  } catch {
    // tmux may not be running during shutdown
  }
}

function shutdown() {
  removeTmuxHook();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start server
server.listen(PORT, HOST, () => {
  console.log(`MuxTunnel server running at http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws?pane=SESSION:WINDOW.PANE`);
  console.log(`API endpoint: http://${HOST}:${PORT}/api/sessions`);

  if (!isTmuxRunning()) {
    console.warn("\n⚠️  tmux is not running! Start tmux to use MuxTunnel.\n");
  } else {
    installTmuxHook();
  }
});
