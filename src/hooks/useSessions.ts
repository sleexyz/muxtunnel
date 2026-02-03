import { useState, useEffect, useCallback } from "react";
import type { TmuxSession } from "../types";

export function useSessions(refreshInterval = 2000) {
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error("Failed to fetch sessions");
      const data = await res.json();
      setSessions(data);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchSessions, refreshInterval]);

  const closePane = useCallback(async (target: string) => {
    try {
      const res = await fetch(`/api/panes/${encodeURIComponent(target)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        console.error("Failed to close pane:", data.error);
        return false;
      }
      await fetchSessions();
      return true;
    } catch (err) {
      console.error("Failed to close pane:", err);
      return false;
    }
  }, [fetchSessions]);

  const markClaudeSessionViewed = useCallback(async (sessionId: string) => {
    try {
      await fetch(`/api/claude-sessions/${encodeURIComponent(sessionId)}/viewed`, {
        method: "POST",
      });
    } catch (err) {
      console.error("Failed to mark session viewed:", err);
    }
  }, []);

  return {
    sessions,
    loading,
    error,
    refresh: fetchSessions,
    closePane,
    markClaudeSessionViewed,
  };
}
