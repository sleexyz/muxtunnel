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
  onRequestRefresh?: () => void;
}

interface CellDimensions {
  width: number;
  height: number;
}

/** Measure cell dimensions using Canvas API — synchronous, no DOM mount needed. */
function measureCellDimensions(fontSize: number, fontFamily: string): CellDimensions {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px ${fontFamily}`;
  const metrics = ctx.measureText("W");
  const width = metrics.width;
  const height =
    (metrics.fontBoundingBoxAscent ?? fontSize * 0.8) +
    (metrics.fontBoundingBoxDescent ?? fontSize * 0.2);
  return { width, height };
}

export function TerminalView({
  session,
  currentPane,
  sessions,
  wsRef,
  settings,
  onRequestRefresh,
}: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const cropContainerRef = useRef<HTMLDivElement>(null);
  const positionerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [cellDimensions, setCellDimensions] = useState<CellDimensions | null>(null);
  const lastSessionRef = useRef<string | null>(null);
  const lastFontKeyRef = useRef<string>("");
  const wsGenerationRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerSizeRef = useRef<{ width: number; height: number } | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

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

  // Compute cols/rows from container size, cell dims, and settings
  const computeSize = useCallback(
    (containerWidth: number, containerHeight: number, cellDims: CellDimensions) => {
      const padding = settings.window?.padding ?? 0;
      const margin = settings.window?.margin ?? 0;
      const border = 1;
      const inset = padding + margin + border;
      const availableWidth = containerWidth - 2 * inset;
      const availableHeight = containerHeight - 2 * inset;

      const cols = Math.max(20, Math.floor(availableWidth / cellDims.width));
      const totalRows = Math.max(6, Math.floor(availableHeight / cellDims.height));
      // totalRows includes the tmux status bar row
      return { cols, totalRows };
    },
    [settings.window?.padding, settings.window?.margin]
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
      // Crop to content area only (excludes tmux status bar)
      cropContainerRef.current.style.height = `${height * dims.height}px`;
      positionerRef.current.style.transform = "translate(0, 0)";
    },
    [session]
  );

  // ResizeObserver: track wrapper size and live-resize terminal
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      containerSizeRef.current = { width, height };

      // Debounced live resize of existing terminal
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const terminal = terminalInstanceRef.current;
        const dims = cellDimensions;
        if (!terminal || !dims) return;

        const { cols, totalRows } = computeSize(width, height, dims);
        const contentRows = totalRows - 1; // subtract tmux status row

        const last = lastSentSizeRef.current;
        if (last && last.cols === cols && last.rows === totalRows) return;

        // Resize xterm.js
        terminal.resize(cols, totalRows);
        lastSentSizeRef.current = { cols, rows: totalRows };

        // Update DOM sizes
        const fullWidth = cols * dims.width;
        const fullHeight = totalRows * dims.height;
        if (terminalRef.current) {
          terminalRef.current.style.width = `${fullWidth}px`;
          terminalRef.current.style.height = `${fullHeight}px`;
        }
        if (positionerRef.current) {
          positionerRef.current.style.width = `${fullWidth}px`;
          positionerRef.current.style.height = `${fullHeight}px`;
        }

        // Update crop container for full session view
        if (cropContainerRef.current) {
          cropContainerRef.current.style.width = `${cols * dims.width}px`;
          cropContainerRef.current.style.height = `${contentRows * dims.height}px`;
        }

        // Send resize over existing WebSocket
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows: totalRows }));
          // Trigger immediate session refresh after tmux reflows
          if (onRequestRefresh) {
            setTimeout(onRequestRefresh, 200);
          }
        }
      }, 150);
    });

    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [cellDimensions, computeSize, wsRef, onRequestRefresh]);

  // Initialize terminal and connect WebSocket when session changes
  useEffect(() => {
    if (!session || !terminalRef.current) {
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

    // Measure cell dimensions before creating terminal
    const canvasCellDims = measureCellDimensions(fontSize, fontFamily);

    // Compute cols/rows from viewport
    const container = containerSizeRef.current;
    // Use wrapper element size if ResizeObserver hasn't fired yet
    const wrapperEl = wrapperRef.current;
    const containerWidth = container?.width ?? wrapperEl?.clientWidth ?? 800;
    const containerHeight = container?.height ?? wrapperEl?.clientHeight ?? 600;

    const { cols, totalRows } = computeSize(containerWidth, containerHeight, canvasCellDims);

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

    // Create terminal at viewport-computed size
    const terminal = new Terminal({
      cols,
      rows: totalRows,
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

    // Set dimensions after render — use actual renderer cell dims if available
    requestAnimationFrame(() => {
      if (!terminal) return;

      let dims = canvasCellDims;
      const core = (terminal as any)._core;
      if (core?._renderService?.dimensions?.css?.cell) {
        dims = core._renderService.dimensions.css.cell;
      }

      const fullWidth = cols * dims.width;
      const fullHeight = totalRows * dims.height;

      if (terminalRef.current) {
        terminalRef.current.style.width = `${fullWidth}px`;
        terminalRef.current.style.height = `${fullHeight}px`;
      }
      if (positionerRef.current) {
        positionerRef.current.style.width = `${fullWidth}px`;
        positionerRef.current.style.height = `${fullHeight}px`;
      }

      setCellDimensions({ width: dims.width, height: dims.height });
      lastSentSizeRef.current = { cols, rows: totalRows };

      // If the actual renderer cell dims differ from canvas measurement, we may
      // need different cols/rows. Recalculate and send a resize if needed.
      if (dims !== canvasCellDims) {
        const corrected = computeSize(containerWidth, containerHeight, dims);
        if (corrected.cols !== cols || corrected.totalRows !== totalRows) {
          terminal.resize(corrected.cols, corrected.totalRows);
          lastSentSizeRef.current = { cols: corrected.cols, rows: corrected.totalRows };

          const correctedFullWidth = corrected.cols * dims.width;
          const correctedFullHeight = corrected.totalRows * dims.height;
          if (terminalRef.current) {
            terminalRef.current.style.width = `${correctedFullWidth}px`;
            terminalRef.current.style.height = `${correctedFullHeight}px`;
          }
          if (positionerRef.current) {
            positionerRef.current.style.width = `${correctedFullWidth}px`;
            positionerRef.current.style.height = `${correctedFullHeight}px`;
          }
        }
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

      const currentSize = lastSentSizeRef.current;
      const wsCols = currentSize?.cols ?? cols;
      const wsRows = currentSize?.rows ?? totalRows;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws?pane=${encodeURIComponent(paneTarget)}&cols=${wsCols}&rows=${wsRows}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay = 1000;
        // Trigger refresh so tmux geometry is picked up after connect
        if (onRequestRefresh) {
          setTimeout(onRequestRefresh, 200);
        }
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
  }, [session, currentPane, wsRef, settings, computeSize, onRequestRefresh]);

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
  const bgFilter = settings.background?.filter;

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
        filter: bgFilter,
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  ) : null;

  const windowPadding = settings.window?.padding;
  const windowMargin = settings.window?.margin;
  const hasFrame = windowPadding || windowMargin;
  const frameStyle = hasFrame ? {
    padding: windowPadding,
    margin: windowMargin,
    background: "#1e1e1e",
    position: "relative" as const,
    zIndex: 1,
    borderRadius: 10,
    boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)",
    border: "1px solid rgba(255,255,255,0.08)",
    overflow: "hidden" as const,
  } : undefined;

  if (!session) {
    return (
      <div id="terminal-wrapper" ref={wrapperRef}>
        {backgroundDiv}
        <div className="no-selection">Select a pane from the sidebar</div>
      </div>
    );
  }

  const cropContainer = (
    <div id="crop-container" ref={cropContainerRef}>
      <div id="terminal-positioner" ref={positionerRef}>
        <div id="terminal" ref={terminalRef} />
      </div>
    </div>
  );

  return (
    <div id="terminal-wrapper" ref={wrapperRef}>
      {backgroundDiv}
      {hasFrame ? <div style={frameStyle}>{cropContainer}</div> : cropContainer}
    </div>
  );
}
