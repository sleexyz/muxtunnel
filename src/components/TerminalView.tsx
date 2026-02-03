import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TmuxSession, TmuxPane } from "../types";

interface TerminalViewProps {
  session: TmuxSession | null;
  currentPane: string | null;
  sessions: TmuxSession[];
  wsRef: React.MutableRefObject<WebSocket | null>;
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
}: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const cropContainerRef = useRef<HTMLDivElement>(null);
  const positionerRef = useRef<HTMLDivElement>(null);
  const [cellDimensions, setCellDimensions] = useState<CellDimensions | null>(null);
  const lastSessionRef = useRef<string | null>(null);

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

    // Only reinitialize if session changed
    if (lastSessionRef.current === session.name && terminalInstanceRef.current) {
      return;
    }
    lastSessionRef.current = session.name;

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
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
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

    // Connect WebSocket
    const paneTarget = currentPane || session.windows[0]?.panes[0]?.target;
    if (paneTarget) {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws?pane=${encodeURIComponent(paneTarget)}&cols=${cols}&rows=${rows}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const data = new Uint8Array(event.data);
          terminal.write(data);
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

      ws.onclose = () => {
        terminal.write("\r\n\x1b[31m[Connection closed]\x1b[0m\r\n");
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
      };
    }

    return () => {
      // Cleanup on unmount only
    };
  }, [session, currentPane, wsRef]);

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

  if (!session) {
    return (
      <div id="terminal-wrapper">
        <div className="no-selection">Select a pane from the sidebar</div>
      </div>
    );
  }

  return (
    <div id="terminal-wrapper">
      <div id="crop-container" ref={cropContainerRef}>
        <div id="terminal-positioner" ref={positionerRef}>
          <div id="terminal" ref={terminalRef} />
        </div>
      </div>
    </div>
  );
}
