import { useState, useEffect, useCallback, useRef } from "react";
import type { TmuxSession } from "../types";
import { mux } from "../mux-client";

export function useSessionOrder() {
  const [order, setOrder] = useState<string[]>([]);
  const fetchedRef = useRef(false);

  // Fetch saved order once on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    mux.getSessionOrder()
      .then((data) => {
        if (Array.isArray(data)) setOrder(data);
      })
      .catch(() => {});
  }, []);

  // Apply saved order to sessions list:
  // - Known sessions come first in saved order (skip deleted)
  // - New sessions appended at end sorted by activity
  const applyOrder = useCallback(
    (sessions: TmuxSession[]): TmuxSession[] => {
      const byName = new Map(sessions.map((s) => [s.name, s]));
      const result: TmuxSession[] = [];
      const placed = new Set<string>();

      // Saved order first
      for (const name of order) {
        const s = byName.get(name);
        if (s) {
          result.push(s);
          placed.add(name);
        }
      }

      // New sessions appended in server order (stable)
      const unsorted = sessions.filter((s) => !placed.has(s.name));
      result.push(...unsorted);

      return result;
    },
    [order]
  );

  const saveOrder = useCallback((names: string[]) => {
    setOrder(names);
    mux.saveSessionOrder(names).catch(() => {});
  }, []);

  const reorder = useCallback(
    (sessions: TmuxSession[], fromIndex: number, toIndex: number) => {
      const names = sessions.map((s) => s.name);
      const [moved] = names.splice(fromIndex, 1);
      names.splice(toIndex, 0, moved);
      saveOrder(names);
    },
    [saveOrder]
  );

  return { applyOrder, reorder, saveOrder };
}
