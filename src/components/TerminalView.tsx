import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TmuxSession, TmuxPane } from "../types";
import type { MuxTunnelSettings } from "../hooks/useSettings";
import { getBackgroundImageUrl } from "../hooks/useSettings";

interface TerminalViewProps {
  session: TmuxSession | null;
  currentPane: string | null;
  sessions: TmuxSession[];
  wsRef: React.MutableRefObject<WebSocket | null>;
  settings: MuxTunnelSettings;
}

interface CellDimensions {
  width: number;
  height: number;
}

export function TerminalView({
  session,
  currentPane,
  sessions,
  wsRef,
  settings,
}: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const cropContainerRef = useRef<HTMLDivElement>(null);
  const positionerRef = useRef<HTMLDivElement>(null);
  const [cellDimensions, setCellDimensions] = useState<CellDimensions | null>(null);
  const lastSessionRef = useRef<string | null>(null);
  const lastFontKeyRef = useRef<string>("");
  const wsGenerationRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const findPane = useCallback(
    (target: string): TmuxPane | null => {
      for (const s of sessions) {
        for (const window of s.windows) {
          for (const pane of window.panes) {
            if (pane.target === target) {
              return pane;
            }
          }
        }
      }
      return null;
    },
    [sessions]
  );

  // Apply crop to show only the selected pane
  const applyCropForPane = useCallback(
    (target: string, dims: CellDimensions) => {
      const pane = findPane(target);
      if (!pane || !cropContainerRef.current || !positionerRef.current) {
        return;
      }

      const effectiveLeft = pane.left;
      const effectiveTop = pane.top;

      cropContainerRef.current.style.width = `${pane.cols * dims.width}px`;
      cropContainerRef.current.style.height = `${pane.rows * dims.height}px`;
      positionerRef.current.style.transform = `translate(${-effectiveLeft * dims.width}px, ${-effectiveTop * dims.height}px)`;
    },
    [findPane]
  );

  // Show full session view (no cropping)
  const showFullSession = useCallback(
    (dims: CellDimensions) => {
      if (!session?.dimensions || !cropContainerRef.current || !positionerRef.current) {
        return;
      }

      const { width, height } = session.dimensions;

      cropContainerRef.current.style.width = `${width * dims.width}px`;
      cropContainerRef.current.style.height = `${height * dims.height}px`;
      positionerRef.current.style.transform = "translate(0, 0)";
    },
    [session]
  );

  // Initialize terminal and connect WebSocket when session changes
  useEffect(() => {
    if (!session || !terminalRef.current) {
      return;
    }

    if (!session.dimensions) {
      return;
    }

    // Detect font settings changes
    const fontSize = settings.terminal?.fontSize ?? 14;
    const fontFamily = settings.terminal?.fontFamily ?? 'Menlo, Monaco, "Courier New", monospace';
    const fontKey = `${fontSize}|${fontFamily}`;

    // Only reinitialize if session or font settings changed
    if (lastSessionRef.current === session.name && lastFontKeyRef.current === fontKey && terminalInstanceRef.current) {
      return;
    }
    lastSessionRef.current = session.name;
    lastFontKeyRef.current = fontKey;

    const { width: cols, height: rows } = session.dimensions;

    // Close existing WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Dispose existing terminal
    if (terminalInstanceRef.current) {
      terminalInstanceRef.current.dispose();
    }
    terminalRef.current.innerHTML = "";

    // Create terminal at fixed session size
    const terminal = new Terminal({
      cols,
      rows,
      cursorBlink: true,
      fontSize,
      fontFamily,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
    });

    try {
      terminal.loadAddon(new WebglAddon());
    } catch (e) {
      console.warn("WebGL not available:", e);
    }

    terminal.open(terminalRef.current);
    terminalInstanceRef.current = terminal;

    // Handle user input - send to WebSocket
    terminal.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "keys", keys: data }));
      }
    });

    // Set dimensions after render
    requestAnimationFrame(() => {
      if (!terminal) return;

      const core = (terminal as any)._core;
      if (core?._renderService?.dimensions?.css?.cell) {
        const dims = core._renderService.dimensions.css.cell;
        const fullWidth = cols * dims.width;
        const fullHeight = rows * dims.height;

        if (terminalRef.current) {
          terminalRef.current.style.width = `${fullWidth}px`;
          terminalRef.current.style.height = `${fullHeight}px`;
        }
        if (positionerRef.current) {
          positionerRef.current.style.width = `${fullWidth}px`;
          positionerRef.current.style.height = `${fullHeight}px`;
        }

        setCellDimensions({ width: dims.width, height: dims.height });
      }
    });

    // Connect WebSocket with auto-reconnection
    const paneTarget = currentPane || session.windows[0]?.panes[0]?.target;
    const generation = ++wsGenerationRef.current;

    // Cancel any pending reconnect from a previous connection
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    let reconnectDelay = 1000;
    const MAX_RECONNECT_DELAY = 10_000;

    function connect() {
      if (wsGenerationRef.current !== generation || !paneTarget) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws?pane=${encodeURIComponent(paneTarget)}&cols=${cols}&rows=${rows}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay = 1000;
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          terminal.write(new Uint8Array(event.data));
          return;
        }
        try {
          JSON.parse(event.data);
        } catch {
          if (typeof event.data === "string") {
            terminal.write(event.data);
          }
        }
      };

      ws.onclose = (event) => {
        if (wsGenerationRef.current !== generation) return;

        // Don't reconnect on permanent server-side rejections (4xxx codes)
        if (event.code >= 4000 && event.code < 5000) {
          terminal.write(`\r\n\x1b[31m[Connection closed: ${event.reason || "server rejected"}]\x1b[0m\r\n`);
          return;
        }

        console.warn(`[WS] closed (code: ${event.code}, reason: ${event.reason || "none"})`);
        terminal.write("\r\n\x1b[33m[Reconnecting...]\x1b[0m");
        reconnectTimerRef.current = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
          connect();
        }, reconnectDelay);
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
      };
    }

    connect();
  }, [session, currentPane, wsRef, settings]);

  // Cleanup WebSocket and reconnect timers on unmount
  useEffect(() => {
    return () => {
      wsGenerationRef.current++;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [wsRef]);

  // Apply crop when pane or cell dimensions change
  useEffect(() => {
    if (!cellDimensions || !session) {
      return;
    }

    if (currentPane) {
      applyCropForPane(currentPane, cellDimensions);
    } else {
      showFullSession(cellDimensions);
    }
  }, [currentPane, session, cellDimensions, applyCropForPane, showFullSession]);

  const bgUrl = getBackgroundImageUrl(settings);
  const bgOpacity = settings.background?.opacity ?? 0.15;
  const bgSize = settings.background?.size ?? "cover";

  const backgroundDiv = bgUrl ? (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage: `url(${bgUrl})`,
        backgroundSize: bgSize,
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        opacity: bgOpacity,
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  ) : null;

  if (!session) {
    return (
      <div id="terminal-wrapper">
        {backgroundDiv}
        <div className="no-selection">Select a pane from the sidebar</div>
      </div>
    );
  }

  return (
    <div id="terminal-wrapper">
      {backgroundDiv}
      <div id="crop-container" ref={cropContainerRef}>
        <div id="terminal-positioner" ref={positionerRef}>
          <div id="terminal" ref={terminalRef} />
        </div>
      </div>
    </div>
  );
}
