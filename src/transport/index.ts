import type { MuxTransport } from "./types";
import { WebTransport } from "./web";

export type { MuxTransport, PtyStream } from "./types";

export function createTransport(): MuxTransport {
  // Future: check window.__TAURI__ and return TauriTransport
  return new WebTransport();
}
