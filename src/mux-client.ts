import { createTransport } from "./transport";
import type { MuxTransport, PtyStream } from "./transport";
import type { TmuxSession } from "./types";
import type { MuxTunnelSettings } from "./hooks/useSettings";

export interface ProjectEntry {
  score: number;
  path: string;
  name: string;
}

export class MuxClient {
  constructor(private transport: MuxTransport) {}

  listSessions(): Promise<TmuxSession[]> {
    return this.transport.call("sessions.list");
  }

  createSession(name: string, cwd: string): Promise<void> {
    return this.transport.call("sessions.create", { name, cwd });
  }

  deleteSession(name: string): Promise<void> {
    return this.transport.call("sessions.delete", { name });
  }

  deletePane(target: string): Promise<void> {
    return this.transport.call("panes.delete", { target });
  }

  sendInput(target: string, text: string): Promise<void> {
    return this.transport.call("panes.input", { target, text });
  }

  interrupt(target: string): Promise<void> {
    return this.transport.call("panes.interrupt", { target });
  }

  listProjects(): Promise<ProjectEntry[]> {
    return this.transport.call("projects.list");
  }

  resolveProject(name: string): Promise<{ path: string; name: string }> {
    return this.transport.call("projects.resolve", { name });
  }

  markClaudeSessionViewed(id: string): Promise<void> {
    return this.transport.call("claude.markViewed", { id });
  }

  getSessionOrder(): Promise<string[]> {
    return this.transport.call("sessionOrder.get");
  }

  saveSessionOrder(order: string[]): Promise<void> {
    return this.transport.call("sessionOrder.save", { order });
  }

  getSettings(): Promise<{ version: number; settings: MuxTunnelSettings }> {
    return this.transport.call("settings.get");
  }

  backgroundImageUrl(): string {
    return this.transport.asset("background");
  }

  connectPty(target: string, cols: number, rows: number): PtyStream {
    return this.transport.stream("pty.connect", { target, cols, rows });
  }
}

/** Singleton client instance */
export const mux = new MuxClient(createTransport());
