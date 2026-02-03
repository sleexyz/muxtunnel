import { useState, useEffect, useCallback, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { TerminalView } from "./components/TerminalView";
import { InputBar } from "./components/InputBar";
import type { TmuxSession, TmuxPane } from "./types";

export function App() {
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [currentPane, setCurrentPane] = useState<string | null>(null);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    }
  }, []);

  // Poll sessions
  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 2000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  // Find pane by target
  const findPane = useCallback(
    (target: string): TmuxPane | null => {
      for (const session of sessions) {
        for (const window of session.windows) {
          for (const pane of window.panes) {
            if (pane.target === target) {
              return pane;
            }
          }
        }
      }
      return null;
    },
    [sessions]
  );

  // Get session by name
  const getSession = useCallback(
    (name: string): TmuxSession | null => {
      return sessions.find((s) => s.name === name) || null;
    },
    [sessions]
  );

  // Select a pane
  const handleSelectPane = useCallback(
    (target: string) => {
      const pane = findPane(target);
      if (!pane) return;

      setCurrentPane(target);
      setCurrentSession(pane.sessionName);
    },
    [findPane]
  );

  // Select a session (full view)
  const handleSelectSession = useCallback((sessionName: string) => {
    setCurrentPane(null);
    setCurrentSession(sessionName);
  }, []);

  // Close a pane
  const handleClosePane = useCallback(
    async (target: string) => {
      try {
        const res = await fetch(`/api/panes/${encodeURIComponent(target)}`, {
          method: "DELETE",
        });
        if (res.ok) {
          if (currentPane === target) {
            setCurrentPane(null);
          }
          await fetchSessions();
        }
      } catch (err) {
        console.error("Failed to close pane:", err);
      }
    },
    [currentPane, fetchSessions]
  );

  // Mark Claude session as viewed
  const handleMarkViewed = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/claude-sessions/${encodeURIComponent(sessionId)}/viewed`, {
        method: "POST",
      });
    } catch (err) {
      console.error("Failed to mark session viewed:", err);
    }
  }, []);

  // Get current session object
  const session = currentSession ? getSession(currentSession) : null;

  return (
    <>
      <Sidebar
        sessions={sessions}
        currentPane={currentPane}
        currentSession={currentSession}
        onSelectPane={handleSelectPane}
        onSelectSession={handleSelectSession}
        onClosePane={handleClosePane}
        onMarkViewed={handleMarkViewed}
      />
      <div id="terminal-container">
        <TerminalView
          session={session}
          currentPane={currentPane}
          sessions={sessions}
          wsRef={wsRef}
        />
        {currentPane && <InputBar target={currentPane} />}
      </div>
    </>
  );
}
