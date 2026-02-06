import { useState, useEffect, useCallback, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { TerminalView } from "./components/TerminalView";
import { InputBar } from "./components/InputBar";
import { CommandPalette } from "./components/CommandPalette";
import type { TmuxSession, TmuxPane } from "./types";
import { useSettings } from "./hooks/useSettings";
import { useSessionOrder } from "./hooks/useSessionOrder";

// Reserved path segments that should not be treated as session names
const RESERVED_PATHS = new Set(["api", "ws", "assets"]);

// Migrate old ?session= URLs to path-based URLs
(function migrateOldUrl() {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session");
  if (session) {
    params.delete("session");
    const newPath = `/${encodeURIComponent(session)}`;
    const qs = params.toString();
    window.history.replaceState({}, "", newPath + (qs ? `?${qs}` : ""));
  }
})();

// Get session from URL pathname
function getSessionFromUrl(): string | null {
  const segment = window.location.pathname.split("/")[1];
  if (!segment || RESERVED_PATHS.has(segment)) return null;
  return decodeURIComponent(segment);
}

// Get pane from URL query param
function getPaneFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("pane");
}

// Convert full pane target to relative (e.g., "main:0.0" -> "0.0")
function paneToRelative(pane: string): string {
  const colonIndex = pane.indexOf(":");
  return colonIndex >= 0 ? pane.slice(colonIndex + 1) : pane;
}

// Convert relative pane to full target (e.g., "0.0" + "main" -> "main:0.0")
function paneToAbsolute(pane: string, session: string): string {
  return pane.includes(":") ? pane : `${session}:${pane}`;
}

// Update URL without refresh — path-based session routing
function updateUrl(session: string | null, pane: string | null) {
  const params = new URLSearchParams();
  // Never keep legacy ?session param
  if (pane) {
    params.set("pane", session ? paneToRelative(pane) : pane);
  }
  const pathname = session ? `/${encodeURIComponent(session)}` : "/";
  const qs = params.toString();
  window.history.pushState({}, "", pathname + (qs ? `?${qs}` : ""));
}

// Read initial state from URL (pane converted to absolute if needed)
function getInitialState(): { session: string | null; pane: string | null } {
  const session = getSessionFromUrl();
  const pane = getPaneFromUrl();
  return {
    session,
    pane: pane && session ? paneToAbsolute(pane, session) : pane,
  };
}

export function App() {
  const initialState = getInitialState();
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [currentPane, setCurrentPane] = useState<string | null>(initialState.pane);
  const [currentSession, setCurrentSession] = useState<string | null>(initialState.session);
  const wsRef = useRef<WebSocket | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarPinned, setSidebarPinned] = useState(false);
  const settings = useSettings();
  const { applyOrder, reorder } = useSessionOrder();

  const [autoCreateAttempted, setAutoCreateAttempted] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // Sessions in user-defined order for sidebar/palette display
  const orderedSessions = applyOrder(sessions);

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

  // Track if change came from popstate (to avoid re-pushing URL)
  const isPopStateRef = useRef(false);

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      isPopStateRef.current = true;
      const session = getSessionFromUrl();
      const pane = getPaneFromUrl();
      setCurrentSession(session);
      setCurrentPane(pane && session ? paneToAbsolute(pane, session) : pane);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Auto-create session via zoxide when navigating to a non-existent session
  useEffect(() => {
    if (!currentSession) return;
    if (sessions.length === 0) return; // Still loading
    const exists = sessions.some((s) => s.name === currentSession);
    if (exists) return;
    if (autoCreateAttempted === currentSession) return;

    setAutoCreateAttempted(currentSession);

    (async () => {
      try {
        const res = await fetch(`/api/zoxide/${encodeURIComponent(currentSession)}`);
        if (!res.ok) {
          setErrorToast(`No zoxide match for "${currentSession}"`);
          return;
        }
        const { path: cwd, name: resolvedName } = await res.json();
        // Redirect to canonical name if the input was a fuzzy/partial match
        const sessionName = resolvedName || currentSession;
        if (sessionName !== currentSession) {
          setCurrentSession(sessionName);
          return;
        }
        const createRes = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: sessionName, cwd }),
        });
        if (!createRes.ok) {
          setErrorToast(`Failed to create session "${sessionName}"`);
          return;
        }
        await fetchSessions();
      } catch (err) {
        setErrorToast(`Error creating session: ${err}`);
      }
    })();
  }, [currentSession, sessions, autoCreateAttempted, fetchSessions]);

  // Auto-dismiss error toast
  useEffect(() => {
    if (!errorToast) return;
    const timer = setTimeout(() => setErrorToast(null), 4000);
    return () => clearTimeout(timer);
  }, [errorToast]);

  // Update URL when session or pane changes (skip on popstate-triggered changes)
  useEffect(() => {
    if (isPopStateRef.current) {
      isPopStateRef.current = false;
      return;
    }
    updateUrl(currentSession, currentPane);
  }, [currentSession, currentPane]);

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

  // Auto-select first session when none selected and sessions are available
  useEffect(() => {
    if (sessions.length > 0 && !currentSession) {
      // If there's a pane in URL, derive session from it
      if (currentPane) {
        const pane = findPane(currentPane);
        if (pane) {
          setCurrentSession(pane.sessionName);
          return;
        }
      }
      // Otherwise auto-select first session
      setCurrentSession(sessions[0].name);
    }
  }, [sessions, currentSession, currentPane, findPane]);

  // Update document title
  useEffect(() => {
    if (currentPane) {
      const pane = findPane(currentPane);
      const process = pane?.process || "pane";
      document.title = `${process} - ${currentPane}`;
    } else if (currentSession) {
      document.title = `${currentSession} - MuxTunnel`;
    } else {
      document.title = "MuxTunnel";
    }
  }, [currentPane, currentSession, findPane]);

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

  // Close a session
  const handleCloseSession = useCallback(
    async (name: string) => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
        if (res.ok) {
          if (currentSession === name) {
            setCurrentSession(null);
            setCurrentPane(null);
          }
          await fetchSessions();
        }
      } catch (err) {
        console.error("Failed to close session:", err);
      }
    },
    [currentSession, fetchSessions]
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

  // Cmd+P command palette (capture phase to bypass xterm.js)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && e.key === "p") {
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Cmd+B sidebar toggle (capture phase to bypass xterm.js)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && e.key === "b") {
        e.preventDefault();
        e.stopPropagation();
        setSidebarPinned((pinned) => !pinned);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Create a new tmux session from command palette
  const handleCreateSession = useCallback(async (name: string, cwd: string) => {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cwd }),
      });
      if (res.ok) {
        await fetchSessions();
        setCurrentPane(null);
        setCurrentSession(name);
      }
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [fetchSessions]);

  // Get current session object
  const session = currentSession ? getSession(currentSession) : null;

  return (
    <>
      {errorToast && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          background: "#dc2626", color: "white", padding: "8px 16px",
          borderRadius: 6, zIndex: 9999, fontSize: 14, whiteSpace: "nowrap",
        }}>
          {errorToast}
        </div>
      )}
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectSession={(name) => { handleSelectSession(name); setPaletteOpen(false); }}
        onCreateSession={handleCreateSession}
        existingSessions={orderedSessions.map((s) => ({ name: s.name, path: s.path }))}
      />
      {!sidebarPinned && <div id="sidebar-trigger" />}
      <Sidebar
        sessions={orderedSessions}
        currentPane={currentPane}
        currentSession={currentSession}
        pinned={sidebarPinned}
        onSelectPane={handleSelectPane}
        onSelectSession={handleSelectSession}
        onClosePane={handleClosePane}
        onCloseSession={handleCloseSession}
        onMarkViewed={handleMarkViewed}
        onReorder={(from, to) => reorder(orderedSessions, from, to)}
      />
      <div id="terminal-container">
        <WorkspaceBar
          sessions={orderedSessions}
          currentPane={currentPane}
          currentSession={currentSession}
          onSelectPane={handleSelectPane}
          onSelectSession={handleSelectSession}
          onMarkViewed={handleMarkViewed}
        />
        <TerminalView
          session={session}
          currentPane={currentPane}
          sessions={sessions}
          wsRef={wsRef}
          settings={settings}
          onRequestRefresh={fetchSessions}
          onSessionChanged={(name) => { handleSelectSession(name); fetchSessions(); }}
        />
        {currentPane && <InputBar target={currentPane} />}
      </div>
    </>
  );
}
