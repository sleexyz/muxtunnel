export interface MuxTransport {
  /** RPC-style call: method string → typed response */
  call<T>(method: string, params?: Record<string, any>): Promise<T>;
  /** Open a streaming PTY connection */
  stream(method: string, params: Record<string, any>): PtyStream;
  /** Resolve a named asset to a URL */
  asset(path: string): string;
}

export interface PtyStream {
  /** Binary PTY data (terminal output) */
  onData(cb: (data: ArrayBuffer) => void): () => void;
  /** JSON control messages from server */
  onMessage(cb: (msg: any) => void): () => void;
  /** Connection opened */
  onOpen(cb: () => void): () => void;
  /** Connection closed. code >= 4000 means server-rejected (non-retriable). */
  onClose(cb: (code: number, reason: string) => void): () => void;
  /** Connection error */
  onError(cb: (err: Event) => void): () => void;
  /** Send a JSON control message */
  send(msg: any): void;
  /** Close the stream */
  close(): void;
}
