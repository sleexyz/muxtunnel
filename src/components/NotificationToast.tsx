import { useEffect, useRef, useState } from "react";
import type { NotificationEntry } from "../hooks/useNotifications";

interface NotificationToastProps {
  notifications: Map<string, NotificationEntry>;
  onDismiss: (sessionId: string) => void;
  onClick: (sessionId: string) => void;
}

export function NotificationToast({
  notifications,
  onDismiss,
  onClick,
}: NotificationToastProps) {
  // Track which toasts are in "exiting" state for fade-out animation
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const exitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const handleDismiss = (sessionId: string) => {
    setExiting((prev) => new Set(prev).add(sessionId));
    exitTimers.current.set(
      sessionId,
      setTimeout(() => {
        setExiting((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
        exitTimers.current.delete(sessionId);
        onDismiss(sessionId);
      }, 200) // match CSS animation duration
    );
  };

  // Cleanup exit timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of exitTimers.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  if (notifications.size === 0) return null;

  const entries = Array.from(notifications.values()).sort(
    (a, b) => a.timestamp - b.timestamp
  );

  return (
    <div className="toast-stack">
      {entries.map((entry) => {
        const isExiting = exiting.has(entry.sessionId);
        return (
          <div
            key={entry.sessionId}
            className={`toast-item${isExiting ? " toast-exit" : ""}`}
            onClick={() => onClick(entry.sessionId)}
          >
            <div className="toast-content">
              <div className="toast-title">{entry.sessionName}</div>
              {entry.summary && (
                <div className="toast-summary">{entry.summary}</div>
              )}
            </div>
            <button
              className="toast-dismiss"
              onClick={(e) => {
                e.stopPropagation();
                handleDismiss(entry.sessionId);
              }}
            >
              &times;
            </button>
          </div>
        );
      })}
    </div>
  );
}
