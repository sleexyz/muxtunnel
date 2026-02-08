import type { MuxTransport } from "./types";
import { WebTransport } from "./web";

export type { MuxTransport, PtyStream } from "./types";

// Detect Tauri v2 environment
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createTransport(): MuxTransport {
  if (isTauri()) {
    // Lazy-load TauriTransport. We use a wrapper that loads the real
    // transport asynchronously but presents a synchronous interface.
    // TauriTransport.call() already awaits its internal init promise,
    // and stream() queues operations until ready.
    return new TauriTransportProxy();
  }
  return new WebTransport();
}

/**
 * Proxy that synchronously creates a transport but lazily loads the
 * @tauri-apps/api module. This avoids bundling Tauri deps in web mode.
 */
class TauriTransportProxy implements MuxTransport {
  private transport: Promise<MuxTransport>;

  constructor() {
    this.transport = import("./tauri").then((m) => new m.TauriTransport());
  }

  async call<T>(method: string, params?: Record<string, any>): Promise<T> {
    const t = await this.transport;
    return t.call(method, params);
  }

  stream(method: string, params: Record<string, any>) {
    // We need to return PtyStream synchronously, but the real transport
    // may not be loaded yet. TauriTransport.stream() already handles
    // this internally by queuing until ready.
    //
    // Create a deferred PtyStream that forwards to the real one once loaded.
    return new DeferredPtyStream(this.transport, method, params);
  }

  asset(path: string): string {
    // Asset URLs are known statically for Tauri
    if (path === "background") return "tauri://asset/background";
    return "";
  }
}

import type { PtyStream } from "./types";

class DeferredPtyStream implements PtyStream {
  private real: Promise<PtyStream>;

  constructor(
    transport: Promise<MuxTransport>,
    method: string,
    params: Record<string, any>,
  ) {
    this.real = transport.then((t) => t.stream(method, params));
  }

  onData(cb: (data: ArrayBuffer) => void) {
    let unsub = () => {};
    this.real.then((s) => {
      unsub = s.onData(cb);
    });
    return () => unsub();
  }

  onMessage(cb: (msg: any) => void) {
    let unsub = () => {};
    this.real.then((s) => {
      unsub = s.onMessage(cb);
    });
    return () => unsub();
  }

  onOpen(cb: () => void) {
    let unsub = () => {};
    this.real.then((s) => {
      unsub = s.onOpen(cb);
    });
    return () => unsub();
  }

  onClose(cb: (code: number, reason: string) => void) {
    let unsub = () => {};
    this.real.then((s) => {
      unsub = s.onClose(cb);
    });
    return () => unsub();
  }

  onError(cb: (err: Event) => void) {
    let unsub = () => {};
    this.real.then((s) => {
      unsub = s.onError(cb);
    });
    return () => unsub();
  }

  send(msg: any) {
    this.real.then((s) => s.send(msg));
  }

  close() {
    this.real.then((s) => s.close());
  }
}
