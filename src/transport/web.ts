import type { MuxTransport, PtyStream } from "./types";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface Route {
  method: HttpMethod;
  path: string | ((params: Record<string, any>) => string);
  body?: (params: Record<string, any>) => any;
}

const routes: Record<string, Route> = {
  "sessions.list": {
    method: "GET",
    path: "/api/sessions",
  },
  "sessions.create": {
    method: "POST",
    path: "/api/sessions",
    body: (p) => ({ name: p.name, cwd: p.cwd }),
  },
  "sessions.delete": {
    method: "DELETE",
    path: (p) => `/api/sessions/${encodeURIComponent(p.name)}`,
  },
  "panes.delete": {
    method: "DELETE",
    path: (p) => `/api/panes/${encodeURIComponent(p.target)}`,
  },
  "panes.input": {
    method: "POST",
    path: (p) => `/api/panes/${encodeURIComponent(p.target)}/input`,
    body: (p) => ({ text: p.text }),
  },
  "panes.interrupt": {
    method: "POST",
    path: (p) => `/api/panes/${encodeURIComponent(p.target)}/interrupt`,
  },
  "projects.list": {
    method: "GET",
    path: "/api/projects",
  },
  "projects.resolve": {
    method: "GET",
    path: (p) => `/api/projects/resolve/${encodeURIComponent(p.name)}`,
  },
  "claude.markViewed": {
    method: "POST",
    path: (p) => `/api/claude-sessions/${encodeURIComponent(p.id)}/viewed`,
  },
  "sessionOrder.get": {
    method: "GET",
    path: "/api/session-order",
  },
  "sessionOrder.save": {
    method: "PUT",
    path: "/api/session-order",
    body: (p) => p.order,
  },
  "settings.get": {
    method: "GET",
    path: "/api/settings",
  },
};

const assets: Record<string, string> = {
  background: "/api/settings/background",
};

export class WebTransport implements MuxTransport {
  async call<T>(method: string, params?: Record<string, any>): Promise<T> {
    const route = routes[method];
    if (!route) throw new Error(`Unknown method: ${method}`);

    const p = params ?? {};
    const url = typeof route.path === "function" ? route.path(p) : route.path;
    const body = route.body ? JSON.stringify(route.body(p)) : undefined;

    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";

    const res = await fetch(url, { method: route.method, headers, body });
    if (!res.ok) {
      throw new Error(`${method} failed: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  stream(method: string, params: Record<string, any>): PtyStream {
    if (method !== "pty.connect") throw new Error(`Unknown stream: ${method}`);

    const { target, cols, rows } = params;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws?pane=${encodeURIComponent(target)}&cols=${cols}&rows=${rows}`;

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    const dataListeners: Array<(data: ArrayBuffer) => void> = [];
    const msgListeners: Array<(msg: any) => void> = [];
    const openListeners: Array<() => void> = [];
    const closeListeners: Array<(code: number, reason: string) => void> = [];
    const errorListeners: Array<(err: Event) => void> = [];

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        for (const cb of dataListeners) cb(event.data);
        return;
      }
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          for (const cb of msgListeners) cb(msg);
        } catch {
          // Non-JSON text — treat as raw terminal data
          const encoded = new TextEncoder().encode(event.data);
          for (const cb of dataListeners) cb(encoded.buffer);
        }
      }
    };

    ws.onopen = () => {
      for (const cb of openListeners) cb();
    };

    ws.onclose = (event) => {
      for (const cb of closeListeners) cb(event.code, event.reason);
    };

    ws.onerror = (event) => {
      for (const cb of errorListeners) cb(event);
    };

    function removeFrom<T>(arr: T[], item: T) {
      const i = arr.indexOf(item);
      if (i >= 0) arr.splice(i, 1);
    }

    return {
      onData(cb) {
        dataListeners.push(cb);
        return () => removeFrom(dataListeners, cb);
      },
      onMessage(cb) {
        msgListeners.push(cb);
        return () => removeFrom(msgListeners, cb);
      },
      onOpen(cb) {
        openListeners.push(cb);
        return () => removeFrom(openListeners, cb);
      },
      onClose(cb) {
        closeListeners.push(cb);
        return () => removeFrom(closeListeners, cb);
      },
      onError(cb) {
        errorListeners.push(cb);
        return () => removeFrom(errorListeners, cb);
      },
      send(msg) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      },
      close() {
        ws.close();
      },
    };
  }

  asset(path: string): string {
    const url = assets[path];
    if (!url) throw new Error(`Unknown asset: ${path}`);
    return url;
  }
}
