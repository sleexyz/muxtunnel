import type { MuxTransport, PtyStream } from "./types";

// Method name → Tauri command name mapping
const COMMAND_MAP: Record<string, string> = {
  "sessions.list": "sessions_list",
  "sessions.create": "sessions_create",
  "sessions.delete": "sessions_delete",
  "panes.delete": "panes_delete",
  "panes.input": "panes_input",
  "panes.interrupt": "panes_interrupt",
  "projects.list": "projects_list",
  "projects.resolve": "projects_resolve",
  "claude.markViewed": "claude_mark_viewed",
  "sessionOrder.get": "session_order_get",
  "sessionOrder.save": "session_order_save",
  "settings.get": "settings_get",
};

export class TauriTransport implements MuxTransport {
  private invoke!: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  private Channel!: new <T>(onMessage: (msg: T) => void) => { onmessage: (msg: T) => void };
  private convertFileSrc!: (path: string, protocol?: string) => string;
  private ready: Promise<void>;

  constructor() {
    // Dynamically import Tauri APIs so this module doesn't break web builds
    this.ready = this.init();
  }

  private async init() {
    const core = await import("@tauri-apps/api/core");
    this.invoke = core.invoke;
    this.Channel = core.Channel;
    this.convertFileSrc = core.convertFileSrc;
  }

  async call<T>(method: string, params?: Record<string, any>): Promise<T> {
    await this.ready;

    const command = COMMAND_MAP[method];
    if (!command) throw new Error(`Unknown method: ${method}`);

    // Flatten params for Tauri commands (they take named args, not nested objects)
    const args = params ? { ...params } : {};

    return this.invoke(command, args) as Promise<T>;
  }

  stream(method: string, params: Record<string, any>): PtyStream {
    if (method !== "pty.connect") throw new Error(`Unknown stream: ${method}`);

    const { target, cols, rows } = params;

    const dataListeners: Array<(data: ArrayBuffer) => void> = [];
    const msgListeners: Array<(msg: any) => void> = [];
    const openListeners: Array<() => void> = [];
    const closeListeners: Array<(code: number, reason: string) => void> = [];
    const errorListeners: Array<(err: Event) => void> = [];

    let connected = false;

    // Start connection asynchronously
    this.ready.then(async () => {
      try {
        // Create a Tauri Channel for receiving PTY data
        const channel = new this.Channel<any>((message: any) => {
          if (!message) return;

          if (message.type === "data" && message.data) {
            // Convert byte array to ArrayBuffer
            const bytes = new Uint8Array(message.data);
            for (const cb of dataListeners) cb(bytes.buffer);
          } else if (message.type === "pane-info") {
            for (const cb of msgListeners) cb(message);
          } else if (message.type === "exit") {
            for (const cb of closeListeners) cb(1000, "PTY exited");
          } else if (message.type === "error") {
            for (const cb of errorListeners)
              cb(new Event(message.message || "PTY error"));
          }
        });

        // Invoke the pty_connect command
        await this.invoke("pty_connect", {
          target,
          cols,
          rows,
          onData: channel,
        });

        connected = true;
        // Fire onOpen — connection is instant in Tauri IPC
        for (const cb of openListeners) cb();
      } catch (err: any) {
        for (const cb of errorListeners)
          cb(new Event(err?.message || String(err)));
        for (const cb of closeListeners)
          cb(4000, err?.message || String(err));
      }
    });

    function removeFrom<T>(arr: T[], item: T) {
      const i = arr.indexOf(item);
      if (i >= 0) arr.splice(i, 1);
    }

    const self = this;

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
        // If already connected, fire immediately
        if (connected) setTimeout(() => cb(), 0);
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
        if (!connected) return;
        // Send control messages via invoke
        self.ready.then(() => {
          self.invoke("pty_send", { target, msg }).catch((err: any) => {
            console.error("[TauriTransport] pty_send error:", err);
          });
        });
      },
      close() {
        self.ready.then(() => {
          self.invoke("pty_close", { target }).catch(() => {});
        });
      },
    };
  }

  asset(path: string): string {
    if (path === "background") {
      // For background images, we use a tauri command that returns bytes.
      // The frontend will need to handle this differently — use a blob URL.
      // For now, return a sentinel that useSettings can handle.
      return "tauri://asset/background";
    }
    return "";
  }
}
