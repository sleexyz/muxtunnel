import { useRef } from "react";
import type { TmuxSession, TmuxWindow, TmuxPane } from "../types";

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
  pinned,
  onSelectPane,
  onSelectSession,
  onClosePane,
  onCloseSession,
  onMarkViewed,
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

  // Collapse sidebar by briefly disabling pointer-events so the
  // mouse-leave fires immediately and the sidebar hides.
  const collapseSidebar = () => {
    const el = sidebarRef.current;
    if (!el) return;
    el.style.pointerEvents = "none";
    setTimeout(() => {
      el.style.pointerEvents = "";
    }, 100);
  };

  const handlePaneClick = (pane: TmuxPane) => {
    if (pane.target !== currentPane) {
      onSelectPane(pane.target);
      if (pane.claudeSession?.notified) {
        onMarkViewed(pane.claudeSession.sessionId);
      }
    }
    if (!pinned) collapseSidebar();
  };

  return (
    <div id="sidebar" className={pinned ? "pinned" : ""} ref={sidebarRef}>
      <div id="sessions-list">
        {[...sessions].sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0)).map((session) => {
          const isSessionSelected =
            currentSession === session.name && currentPane === null;

          return (
            <div className="session-group" key={session.name}>
              <div
                className={`session-name clickable ${isSessionSelected ? "selected" : ""}`}
                onClick={() => { onSelectSession(session.name); if (!pinned) collapseSidebar(); }}
              >
                {escapeHtml(session.name)}
                <span
                  className="close-btn session-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseSession(session.name);
                  }}
                >
                  &times;
                </span>
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
