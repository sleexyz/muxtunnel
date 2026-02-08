import { useEffect, useRef, useCallback, useState, useMemo } from "react";
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
  onSessionChanged?: (sessionName: string) => void;
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
  onSessionChanged,
}: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const cropContainerRef = useRef<HTMLDivElement>(null);
  const positionerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [cellDimensions, setCellDimensions] = useState<CellDimensions | null>(null);
  const wsGenerationRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerSizeRef = useRef<{ width: number; height: number } | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const currentPaneRef = useRef(currentPane);
  currentPaneRef.current = currentPane;
  const onSessionChangedRef = useRef(onSessionChanged);
  onSessionChangedRef.current = onSessionChanged;

  const fontKey = useMemo(() => {
    const fontSize = settings.terminal?.fontSize ?? 12;
    const fontFamily = settings.terminal?.fontFamily ?? 'Menlo, Monaco, "Courier New", monospace';
    return `${fontSize}|${fontFamily}`;
  }, [settings.terminal?.fontSize, settings.terminal?.fontFamily]);

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

    let rafId: number | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      containerSizeRef.current = { width, height };

      // Use rAF to batch resize into the next frame (avoids multi-frame flash)
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
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

        // Only update crop container when in full-session view.
        // When viewing a specific pane, leave the crop container alone —
        // the crop effect will correct it after the session refresh.
        // Updating it here to full-session dimensions causes a flash
        // (pane → full session → pane).
        if (!currentPaneRef.current && cropContainerRef.current) {
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
      });
    });

    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [cellDimensions, computeSize, wsRef, onRequestRefresh]);

  // Track whether the terminal container div is in the DOM
  // (it's conditionally rendered — absent when session is null)
  const hasSession = !!session;

  // Effect 1: Terminal creation (font-dependent only)
  // Reused across session switches — only recreated when font settings change.
  useEffect(() => {
    if (!terminalRef.current) return;

    const fontSize = settings.terminal?.fontSize ?? 12;
    const fontFamily = settings.terminal?.fontFamily ?? 'Menlo, Monaco, "Courier New", monospace';

    // Measure cell dimensions before creating terminal
    const canvasCellDims = measureCellDimensions(fontSize, fontFamily);

    // Compute cols/rows from viewport
    const container = containerSizeRef.current;
    const wrapperEl = wrapperRef.current;
    const containerWidth = container?.width ?? wrapperEl?.clientWidth ?? 800;
    const containerHeight = container?.height ?? wrapperEl?.clientHeight ?? 600;

    const { cols, totalRows } = computeSize(containerWidth, containerHeight, canvasCellDims);

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

    // Handle user input — reads wsRef dynamically, no closure capture issue
    terminal.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "keys", keys: data }));
      }
    });

    // Synchronously set lastSentSize so Effect 2 can read it immediately
    lastSentSizeRef.current = { cols, rows: totalRows };

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

    return () => {
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.dispose();
        terminalInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSession, fontKey, computeSize, wsRef]);

  // Effect 2: WebSocket connection (session/pane-dependent)
  // Reuses existing terminal instance — just reset + reconnect.
  useEffect(() => {
    const terminal = terminalInstanceRef.current;
    if (!terminal || !session) return;

    // Invalidate old WS callbacks
    const generation = ++wsGenerationRef.current;

    // Tear down existing connection
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Clear buffer so old session content doesn't flash
    terminal.reset();

    const paneTarget = currentPane || session.windows[0]?.panes[0]?.target;
    const currentSize = lastSentSizeRef.current;

    let reconnectDelay = 1000;
    const MAX_RECONNECT_DELAY = 10_000;

    function connect() {
      if (wsGenerationRef.current !== generation || !paneTarget) return;

      const wsCols = currentSize?.cols ?? 80;
      const wsRows = currentSize?.rows ?? 24;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws?pane=${encodeURIComponent(paneTarget)}&cols=${wsCols}&rows=${wsRows}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay = 1000;
        terminalInstanceRef.current?.focus();
        if (onRequestRefresh) {
          setTimeout(onRequestRefresh, 200);
        }
      };

      ws.onmessage = (event) => {
        if (wsGenerationRef.current !== generation) return;
        const term = terminalInstanceRef.current;
        if (!term) return;

        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
          return;
        }
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "session-changed" && msg.session) {
              onSessionChangedRef.current?.(msg.session);
              return;
            }
          } catch {
            term.write(event.data);
          }
        }
      };

      ws.onclose = (event) => {
        if (wsGenerationRef.current !== generation) return;
        const term = terminalInstanceRef.current;

        if (event.code >= 4000 && event.code < 5000) {
          term?.write(`\r\n\x1b[31m[Connection closed: ${event.reason || "server rejected"}]\x1b[0m\r\n`);
          return;
        }

        console.warn(`[WS] closed (code: ${event.code}, reason: ${event.reason || "none"})`);
        term?.write("\r\n\x1b[33m[Reconnecting...]\x1b[0m");
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
  }, [session?.name, currentPane, fontKey, wsRef, onRequestRefresh]);

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
  const bgFilter = settings.background?.filter ?? undefined;

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
