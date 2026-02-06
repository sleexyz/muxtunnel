import { useRef } from "react";
import type { TmuxSession, TmuxWindow, TmuxPane } from "../types";

interface SidebarProps {
  sessions: TmuxSession[];
  currentPane: string | null;
  currentSession: string | null;
  onSelectPane: (target: string) => void;
  onSelectSession: (sessionName: string) => void;
  onClosePane: (target: string) => void;
  onMarkViewed: (sessionId: string) => void;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function Sidebar({
  sessions,
  currentPane,
  currentSession,
  onSelectPane,
  onSelectSession,
  onClosePane,
  onMarkViewed,
}: SidebarProps) {
  if (sessions.length === 0) {
    return (
      <div id="sidebar">
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

  // Collapse sidebar by disabling pointer-events until transition finishes
  const collapseSidebar = () => {
    const el = sidebarRef.current;
    if (!el) return;
    el.style.pointerEvents = "none";
    setTimeout(() => {
      el.style.pointerEvents = "";
    }, 300);
  };

  const handlePaneClick = (pane: TmuxPane) => {
    if (pane.target !== currentPane) {
      onSelectPane(pane.target);
      if (pane.claudeSession?.notified) {
        onMarkViewed(pane.claudeSession.sessionId);
      }
    }
    collapseSidebar();
  };

  return (
    <div id="sidebar" ref={sidebarRef}>
      <div id="sessions-list">
        {sessions.map((session) => {
          const isSessionSelected =
            currentSession === session.name && currentPane === null;

          return (
            <div className="session-group" key={session.name}>
              <div
                className={`session-name clickable ${isSessionSelected ? "selected" : ""}`}
                onClick={() => { onSelectSession(session.name); collapseSidebar(); }}
              >
                {escapeHtml(session.name)}
              </div>

              {session.windows.map((window: TmuxWindow) =>
                window.panes.map((pane: TmuxPane) => {
                  const isSelected = pane.target === currentPane;
                  const hasNotification = pane.claudeSession?.notified;
                  const claudeStatus = pane.claudeSession?.status;
                  const isClaude = pane.process === "claude";

                  return (
                    <div
                      key={pane.target}
                      className={`pane-item ${isSelected ? "selected" : ""} ${hasNotification ? "needs-attention" : ""} ${isClaude ? "is-claude" : ""}`}
                      onClick={() => handlePaneClick(pane)}
                    >
                      {hasNotification && <span className="notification-dot" />}
                      <span className="pane-info">
                        <span className="pane-process">
                          {escapeHtml(pane.process || "")}
                          {claudeStatus === "thinking" ? " ..." : ""}
                        </span>
                      </span>
                      <span className="pane-actions">
                        {pane.needsAttention && (
                          <span className="attention-badge">!</span>
                        )}
                        <span
                          className="close-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onClosePane(pane.target);
                          }}
                        >
                          &times;
                        </span>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
