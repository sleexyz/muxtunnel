import { useState, useEffect, useCallback } from "react";
import type { TmuxSession } from "../types";
import { mux } from "../mux-client";

export function useSessions(refreshInterval = 2000) {
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await mux.listSessions();
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
      await mux.deletePane(target);
      await fetchSessions();
      return true;
    } catch (err) {
      console.error("Failed to close pane:", err);
      return false;
    }
  }, [fetchSessions]);

  const markClaudeSessionViewed = useCallback(async (sessionId: string) => {
    try {
      await mux.markClaudeSessionViewed(sessionId);
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
