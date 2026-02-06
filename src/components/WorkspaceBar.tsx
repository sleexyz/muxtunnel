import type { TmuxSession, TmuxPane } from "../types";


interface WorkspaceBarProps {
  sessions: TmuxSession[];
  currentPane: string | null;
  currentSession: string | null;
  onSelectPane: (target: string) => void;
  onSelectSession: (sessionName: string) => void;
  onMarkViewed: (sessionId: string) => void;
}

function getAllPanes(session: TmuxSession): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const w of session.windows) {
    for (const p of w.panes) {
      panes.push(p);
    }
  }
  return panes;
}

type DotKind =
  | "normal"
  | "claude-thinking"
  | "claude-done"
  | "attention"
  | "claude-attention"

function getDotKind(pane: TmuxPane): DotKind {
  const isClaude = pane.process === "claude";
  const needsAttention = !!pane.needsAttention;

  if (isClaude && needsAttention) return "claude-attention";
  if (needsAttention) return "attention";
  if (isClaude) {
    if (pane.claudeSession?.status === "thinking") return "claude-thinking";
    return "claude-done";
  }
  return "normal";
}

function dotClassName(kind: DotKind): string {
  const base = "wb-dot";
  switch (kind) {
    case "normal":
      return base;
    case "claude-thinking":
      return `${base} dot-claude dot-thinking`;
    case "claude-done":
      return `${base} dot-claude dot-done`;
    case "attention":
      return `${base} dot-attention`;
    case "claude-attention":
      return `${base} dot-claude dot-attention`;
  }
}

export function WorkspaceBar({
  sessions,
  currentPane,
  currentSession,
  onSelectPane,
  onSelectSession,
  onMarkViewed,
}: WorkspaceBarProps) {
  if (sessions.length === 0) return null;

  const handleDotClick = (e: React.MouseEvent, pane: TmuxPane) => {
    e.stopPropagation();
    onSelectPane(pane.target);
    if (pane.claudeSession?.notified) {
      onMarkViewed(pane.claudeSession.sessionId);
    }
  };

  return (
    <div id="workspace-bar">
      {sessions.map((session) => {
        const isSelected = currentSession === session.name;
        const panes = getAllPanes(session);

        return (
          <div
            key={session.name}
            className={`wb-workspace${isSelected ? " wb-selected" : ""}`}
            onClick={() => onSelectSession(session.name)}
          >
            <span className="wb-name">{session.name}</span>
            <span className="wb-dots">
              {panes.map((pane) => {
                const kind = getDotKind(pane);
                const isActiveDot = pane.target === currentPane;
                return (
                  <span
                    key={pane.target}
                    className={`${dotClassName(kind)}${isActiveDot ? " dot-selected" : ""}`}
                    title={`${pane.process || "unknown"} (${pane.windowIndex}.${pane.paneIndex})`}
                    onClick={(e) => handleDotClick(e, pane)}
                  />
                );
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
