import { useEffect, useRef, useCallback, useState } from "react";
import type { Terminal } from "@xterm/xterm";

interface UseWebSocketOptions {
  paneTarget: string | null;
  sessionName: string | null;
  cols: number;
  rows: number;
  terminal: Terminal | null;
}

export function useWebSocket({
  paneTarget,
  sessionName,
  cols,
  rows,
  terminal,
}: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  const sendKeys = useCallback((keys: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "keys", keys }));
    }
  }, []);

  useEffect(() => {
    if (!paneTarget || !terminal || !sessionName) {
      return;
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws?pane=${encodeURIComponent(paneTarget)}&cols=${cols}&rows=${rows}`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const data = new Uint8Array(event.data);
        terminal.write(data);
        return;
      }

      try {
        JSON.parse(event.data);
        // Control messages handled here if needed
      } catch {
        if (typeof event.data === "string") {
          terminal.write(event.data);
        }
      }
    };

    ws.onclose = () => {
      setConnected(false);
      terminal.write("\r\n\x1b[31m[Connection closed]\x1b[0m\r\n");
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [paneTarget, sessionName, cols, rows, terminal]);

  return { connected, sendKeys, ws: wsRef };
}
