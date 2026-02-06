import { useState, useEffect, useRef, useCallback } from "react";

interface ZoxideEntry {
  score: number;
  path: string;
  name: string;
}

interface PaletteItem {
  type: "session" | "workspace";
  name: string;
  path?: string;
}

interface SessionInfo {
  name: string;
  path?: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSession: (name: string) => void;
  onCreateSession: (name: string, cwd: string) => void;
  existingSessions: SessionInfo[];
}

const HOME = (() => {
  // Detect home dir from existing session paths or fallback
  if (typeof window !== "undefined") {
    return "/Users/" + (window.location.hostname === "localhost" ? "" : "");
  }
  return "";
})();

function displayPath(fullPath: string): string {
  // Try to replace home directory prefix with ~
  // We detect home dir as /Users/<username> or /home/<username>
  const match = fullPath.match(/^(\/(?:Users|home)\/[^/]+)(\/.*)?$/);
  if (match) {
    return "~" + (match[2] || "");
  }
  return fullPath;
}

export function CommandPalette({ isOpen, onClose, onSelectSession, onCreateSession, existingSessions }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [zoxideEntries, setZoxideEntries] = useState<ZoxideEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch zoxide entries when opened
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setActiveIndex(0);
    fetch("/api/zoxide")
      .then((res) => res.ok ? res.json() : [])
      .then((data) => setZoxideEntries(data))
      .catch(() => setZoxideEntries([]));
  }, [isOpen]);

  // Auto-focus input
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Build filtered item list
  const items: PaletteItem[] = [];
  const lowerQuery = query.toLowerCase();
  const sessionNames = new Set(existingSessions.map((s) => s.name));

  // Sessions section — order matches sidebar (pre-sorted by caller)
  const filteredSessions = existingSessions
    .filter((s) => s.name.toLowerCase().includes(lowerQuery));
  for (const s of filteredSessions) {
    items.push({ type: "session", name: s.name, path: s.path });
  }

  // Workspaces section — exclude entries that already have a matching session
  const filteredWorkspaces = zoxideEntries.filter((entry) => {
    if (sessionNames.has(entry.name)) return false;
    return entry.name.toLowerCase().includes(lowerQuery) || entry.path.toLowerCase().includes(lowerQuery);
  });
  for (const entry of filteredWorkspaces) {
    items.push({ type: "workspace", name: entry.name, path: entry.path });
  }

  // Clamp active index
  const clampedIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
  if (clampedIndex !== activeIndex && items.length > 0) {
    // Will update on next render
  }

  const handleSelect = useCallback((item: PaletteItem) => {
    if (item.type === "session") {
      onSelectSession(item.name);
    } else if (item.path) {
      // Check if a session with this basename already exists
      if (sessionNames.has(item.name)) {
        onSelectSession(item.name);
      } else {
        onCreateSession(item.name, item.path);
      }
    }
    onClose();
  }, [onSelectSession, onCreateSession, onClose, sessionNames]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const idx = Math.min(activeIndex, items.length - 1);
      if (items[idx]) {
        handleSelect(items[idx]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }, [items, activeIndex, handleSelect, onClose]);

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector(".palette-item.active") as HTMLElement;
    if (active) {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [clampedIndex]);

  // Reset active index when query changes
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!isOpen) return null;

  // Determine section boundaries for labels
  let sessionSectionStart = -1;
  let workspaceSectionStart = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type === "session" && sessionSectionStart === -1) sessionSectionStart = i;
    if (items[i].type === "workspace" && workspaceSectionStart === -1) workspaceSectionStart = i;
  }

  const effectiveIndex = Math.min(activeIndex, Math.max(0, items.length - 1));

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette-container" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Search sessions and workspaces..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && (
            <div className="palette-empty">No matches</div>
          )}
          {items.map((item, i) => (
            <div key={item.type + ":" + item.name + (item.path || "")}>
              {i === sessionSectionStart && (
                <div className="palette-section-label">Sessions</div>
              )}
              {i === workspaceSectionStart && (
                <div className="palette-section-label">Workspaces</div>
              )}
              <div
                className={"palette-item" + (i === effectiveIndex ? " active" : "")}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={() => handleSelect(item)}
              >
                <span className="palette-item-name">{item.name}</span>
                {item.path && <span className="palette-item-path">{displayPath(item.path)}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
