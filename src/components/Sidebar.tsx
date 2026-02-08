import { useRef, useState } from "react";
import type { TmuxSession, TmuxPane } from "../types";

interface SidebarProps {
  sessions: TmuxSession[];
  currentPane: string | null;
  currentSession: string | null;
  pinned: boolean;
  onSelectPane: (target: string) => void;
  onSelectSession: (sessionName: string) => void;
  onClosePane: (target: string) => void;
  onCloseSession: (sessionName: string) => void;
  onMarkViewed: (sessionId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Flatten all panes from a session, ordered by window then pane index. */
function getAllPanes(session: TmuxSession): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const w of session.windows) {
    for (const p of w.panes) {
      panes.push(p);
    }
  }
  return panes;
}

type DotKind = "normal" | "claude-thinking" | "claude-waiting" | "claude-needs-attention";

function getDotKind(pane: TmuxPane): DotKind {
  if (pane.process !== "claude") return "normal";
  if (pane.claudeSession?.status === "thinking") return "claude-thinking";
  if (pane.claudeSession?.notified) return "claude-needs-attention";
  return "claude-waiting";
}

function dotClassName(kind: DotKind): string {
  const base = "pane-dot";
  switch (kind) {
    case "normal":
      return base;
    case "claude-thinking":
      return `${base} dot-claude dot-thinking`;
    case "claude-waiting":
      return `${base} dot-claude dot-done`;
    case "claude-needs-attention":
      return `${base} dot-claude dot-needs-attention`;
  }
}

function dotTooltip(pane: TmuxPane): string {
  const proc = pane.process || "unknown";
  const target = `${pane.windowIndex}.${pane.paneIndex}`;
  return `${proc} (${target})`;
}

export function Sidebar({
  sessions,
  currentPane,
  currentSession,
  pinned,
  onSelectPane,
  onSelectSession,
  onClosePane,
  onCloseSession,
  onMarkViewed,
  onReorder,
}: SidebarProps) {
  if (sessions.length === 0) {
    return (
      <div id="sidebar" className={pinned ? "pinned" : ""}>
        <div style={{ color: "#888", padding: "12px", fontSize: "13px" }}>
          No tmux sessions found.
          <br />
          <br />
          Start tmux and create a session to get started.
        </div>
      </div>
    );
  }

  const sidebarRef = useRef<HTMLDivElement>(null);
  const dragIndexRef = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  const collapseSidebar = () => {
    const el = sidebarRef.current;
    if (!el) return;
    el.style.pointerEvents = "none";
    setTimeout(() => {
      el.style.pointerEvents = "";
    }, 100);
  };

  const handleDotClick = (e: React.MouseEvent, pane: TmuxPane) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectPane(pane.target);
    if (!pinned) collapseSidebar();
  };

  const handleSessionClick = (e: React.MouseEvent, sessionName: string) => {
    e.preventDefault();
    onSelectSession(sessionName);
    if (!pinned) collapseSidebar();
  };

  return (
    <div id="sidebar" className={pinned ? "pinned" : ""} ref={sidebarRef}>
      <div id="sessions-list">
        {sessions.map((session, idx) => {
          const isSelected = currentSession === session.name;
          const panes = getAllPanes(session);

          return (
            <a
              href={`/${encodeURIComponent(session.name)}${pinned ? "?sb=1" : ""}`}
              className={`session-row${isSelected ? " selected" : ""}${dropTarget === idx ? " drop-target" : ""}${dragIndexRef.current === idx ? " dragging" : ""}`}
              key={session.name}
              draggable
              onDragStart={(e) => {
                dragIndexRef.current = idx;
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragIndexRef.current !== null && dragIndexRef.current !== idx) {
                  setDropTarget(idx);
                }
              }}
              onDragLeave={() => {
                setDropTarget((cur) => (cur === idx ? null : cur));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragIndexRef.current;
                if (from !== null && from !== idx) {
                  onReorder(from, idx);
                }
                dragIndexRef.current = null;
                setDropTarget(null);
              }}
              onDragEnd={() => {
                dragIndexRef.current = null;
                setDropTarget(null);
              }}
              onClick={(e) => handleSessionClick(e, session.name)}
            >
              <span className="session-label">
                {escapeHtml(session.name)}
              </span>

              <span className="session-dots">
                {panes.map((pane) => {
                  const kind = getDotKind(pane);
                  const isActiveDot = pane.target === currentPane;
                  return (
                    <span
                      key={pane.target}
                      className={`${dotClassName(kind)}${isActiveDot ? " dot-selected" : ""}`}
                      title={dotTooltip(pane)}
                      onClick={(e) => handleDotClick(e, pane)}
                    />
                  );
                })}
              </span>

              <span
                className="close-btn session-close-btn"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onCloseSession(session.name);
                }}
              >
                &times;
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
