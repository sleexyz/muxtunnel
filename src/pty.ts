/**
 * PTY Session Manager
 *
 * Creates PTY sessions that attach to tmux panes using `tmux attach-session`.
 * This approach makes tmux see a real terminal client, so it:
 * - Resizes the session to match the PTY dimensions
 * - Formats output correctly for the viewer's size
 * - Provides proper bidirectional I/O
 */

import { Pty } from "@replit/ruspty";
import { EventEmitter } from "node:events";

export interface PtySessionOptions {
  /** Target pane in format "session:window.pane" */
  target: string;
  /** Terminal columns */
  cols: number;
  /** Terminal rows */
  rows: number;
}

export interface PtySession extends EventEmitter {
  /** Write data to PTY stdin */
  write(data: string | Buffer): void;
  /** Resize the PTY */
  resize(cols: number, rows: number): void;
  /** Close the PTY session */
  close(): void;
  /** Target pane identifier */
  readonly target: string;
}

/**
 * Create a PTY session that attaches to a tmux pane.
 *
 * The PTY runs `tmux attach-session -t TARGET`, which makes tmux
 * treat this as a real terminal client. The session/pane will be
 * resized to match our PTY dimensions.
 */
export function createPtySession(options: PtySessionOptions): PtySession {
  const { target, cols, rows } = options;

  const emitter = new EventEmitter() as PtySession;

  // Build environment for proper terminal emulation
  // Explicitly set locale for UTF-8 support - launchd doesn't provide these
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
  };

  // Create PTY that runs tmux attach-session
  const pty = new Pty({
    command: "tmux",
    args: ["attach-session", "-t", target],
    envs: env,
    dir: process.cwd(),
    size: { rows, cols },
    onExit: (exitCode, signal) => {
      emitter.emit("exit", exitCode, signal);
    },
  });

  // Forward PTY output to event emitter
  pty.read.on("data", (data: Buffer) => {
    emitter.emit("data", data);
  });

  pty.read.on("error", (err: Error) => {
    emitter.emit("error", err);
  });

  // Surface write errors (e.g., writing to PTY after process exit)
  pty.write.on("error", (err: Error) => {
    emitter.emit("error", err);
  });

  pty.read.on("end", () => {
    emitter.emit("end");
  });

  // Attach methods
  (emitter as any).target = target;

  emitter.write = (data: string | Buffer) => {
    pty.write.write(data);
  };

  emitter.resize = (cols: number, rows: number) => {
    pty.resize({ cols, rows });
  };

  emitter.close = () => {
    pty.close();
  };

  return emitter;
}
