import { useRef, useState, useCallback, useEffect } from "react";
import type { TmuxSession } from "../types";

export interface NotificationEntry {
  sessionId: string;
  sessionName: string;
  summary: string;
  paneTarget: string;
  timestamp: number;
}

const AUTO_DISMISS_MS = 12_000;

// Lazy-loaded audio element (only created after first user gesture)
let audioEl: HTMLAudioElement | null = null;
function getAudio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio("/sounds/notification.wav");
    audioEl.volume = 0.5;
  }
  return audioEl;
}

// Track whether user has interacted with the page (needed for autoplay policy)
let userHasInteracted = false;
if (typeof window !== "undefined") {
  const mark = () => {
    userHasInteracted = true;
    window.removeEventListener("click", mark);
    window.removeEventListener("keydown", mark);
  };
  window.addEventListener("click", mark);
  window.addEventListener("keydown", mark);
}

function playNotificationSound() {
  if (!userHasInteracted) return;
  try {
    const audio = getAudio();
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch {
    // Ignore audio errors
  }
}

function sendBrowserNotification(
  entry: NotificationEntry,
  onClickNavigate: (paneTarget: string, sessionId: string) => void
) {
  if (!document.hidden) return;
  if (typeof Notification === "undefined") return;

  if (Notification.permission === "default") {
    Notification.requestPermission();
    return;
  }
  if (Notification.permission !== "granted") return;

  const n = new Notification(entry.sessionName, {
    body: entry.summary || "Claude needs attention",
    tag: entry.sessionId,
  });
  n.onclick = () => {
    window.focus();
    onClickNavigate(entry.paneTarget, entry.sessionId);
    n.close();
  };
}

export function useNotifications(
  onNavigate: (paneTarget: string) => void,
  onMarkViewed: (sessionId: string) => void,
  currentPane: string | null,
  currentSession: string | null
) {
  const [notifications, setNotifications] = useState<Map<string, NotificationEntry>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const prevNotifiedRef = useRef<Set<string>>(new Set());

  const addNotification = useCallback((entry: NotificationEntry) => {
    setNotifications((prev) => {
      const next = new Map(prev);
      next.set(entry.sessionId, entry);
      return next;
    });

    // Reset auto-dismiss timer
    const existing = timersRef.current.get(entry.sessionId);
    if (existing) clearTimeout(existing);
    timersRef.current.set(
      entry.sessionId,
      setTimeout(() => {
        removeNotification(entry.sessionId);
      }, AUTO_DISMISS_MS)
    );
  }, []);

  const removeNotification = useCallback((sessionId: string) => {
    setNotifications((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
    const timer = timersRef.current.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(sessionId);
    }
  }, []);

  const handleToastClick = useCallback(
    (sessionId: string) => {
      const entry = notifications.get(sessionId);
      if (entry) {
        onNavigate(entry.paneTarget);
        onMarkViewed(entry.sessionId);
        removeNotification(entry.sessionId);
      }
    },
    [notifications, onNavigate, onMarkViewed, removeNotification]
  );

  const handleNavigateFromBrowser = useCallback(
    (paneTarget: string, sessionId: string) => {
      onNavigate(paneTarget);
      onMarkViewed(sessionId);
      removeNotification(sessionId);
    },
    [onNavigate, onMarkViewed, removeNotification]
  );

  // Process session poll data: detect false→true transitions on `notified`
  const processSessionUpdate = useCallback(
    (sessions: TmuxSession[]) => {
      const currentNotified = new Set<string>();

      for (const session of sessions) {
        for (const w of session.windows) {
          for (const pane of w.panes) {
            const cs = pane.claudeSession;
            if (!cs?.notified) continue;
            currentNotified.add(cs.sessionId);

            // Skip if we already know about this notification
            if (prevNotifiedRef.current.has(cs.sessionId)) continue;

            // Skip if user is already viewing this pane
            if (pane.target === currentPane) continue;

            const entry: NotificationEntry = {
              sessionId: cs.sessionId,
              sessionName: session.name,
              summary: cs.summary || "",
              paneTarget: pane.target,
              timestamp: Date.now(),
            };

            addNotification(entry);
            playNotificationSound();
            sendBrowserNotification(entry, handleNavigateFromBrowser);
          }
        }
      }

      prevNotifiedRef.current = currentNotified;
    },
    [currentPane, addNotification, handleNavigateFromBrowser]
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  return {
    notifications,
    removeNotification,
    handleToastClick,
    processSessionUpdate,
  };
}
