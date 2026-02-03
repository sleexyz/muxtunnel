export interface ClaudeSession {
  sessionId: string;
  summary: string;
  status: "thinking" | "done" | "idle";
  notified: boolean;
}

export interface TmuxPane {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  paneId: string;
  target: string;
  active: boolean;
  cols: number;
  rows: number;
  left: number;
  top: number;
  pid: number;
  process: string;
  needsAttention?: boolean;
  attentionReason?: string;
  claudeSession?: ClaudeSession;
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: TmuxPane[];
}

export interface TmuxSession {
  name: string;
  windows: TmuxWindow[];
  dimensions?: { width: number; height: number };
}
