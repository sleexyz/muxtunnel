import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface MuxTunnelSettings {
  background?: {
    image?: string;
    size?: string;
    opacity?: number;
    filter?: string;
  };
  terminal?: {
    fontSize?: number;
    fontFamily?: string;
  };
  window?: {
    padding?: number;
  };
}

const SETTINGS_DIR = path.join(os.homedir(), ".muxtunnel");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

let currentSettings: MuxTunnelSettings = {};
let settingsVersion = 0;

export function loadSettings(): void {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      currentSettings = {};
    } else {
      currentSettings = validate(parsed);
    }
  } catch {
    currentSettings = {};
  }
  settingsVersion++;
}

function validate(raw: any): MuxTunnelSettings {
  const settings: MuxTunnelSettings = {};

  if (raw.background && typeof raw.background === "object") {
    settings.background = {};
    if (typeof raw.background.image === "string") {
      settings.background.image = raw.background.image;
    }
    if (typeof raw.background.size === "string") {
      settings.background.size = raw.background.size;
    }
    if (typeof raw.background.opacity === "number") {
      settings.background.opacity = Math.max(0, Math.min(1, raw.background.opacity));
    }
    if (typeof raw.background.filter === "string") {
      settings.background.filter = raw.background.filter;
    }
  }

  if (raw.terminal && typeof raw.terminal === "object") {
    settings.terminal = {};
    if (typeof raw.terminal.fontSize === "number") {
      settings.terminal.fontSize = raw.terminal.fontSize;
    }
    if (typeof raw.terminal.fontFamily === "string") {
      settings.terminal.fontFamily = raw.terminal.fontFamily;
    }
  }

  if (raw.window && typeof raw.window === "object") {
    settings.window = {};
    if (typeof raw.window.padding === "number") {
      settings.window.padding = Math.max(0, raw.window.padding);
    }
  }

  return settings;
}

export function getSettings(): { settings: MuxTunnelSettings; version: number } {
  return { settings: currentSettings, version: settingsVersion };
}

export function getBackgroundImagePath(): string | null {
  const image = currentSettings.background?.image;
  if (!image) return null;

  // URLs are served directly by the client — not through this endpoint
  if (image.startsWith("http://") || image.startsWith("https://")) return null;

  // Resolve ~ and relative paths
  const resolved = image.startsWith("~")
    ? path.join(os.homedir(), image.slice(1))
    : path.resolve(image);

  try {
    if (fs.statSync(resolved).isFile()) return resolved;
  } catch {
    // File doesn't exist
  }
  return null;
}

export function startSettingsWatching(): void {
  // Ensure directory exists for watching
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  } catch {
    // Already exists
  }

  // Initial load
  loadSettings();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Watch directory (robust against atomic saves from vim/emacs)
  try {
    fs.watch(SETTINGS_DIR, (_event, filename) => {
      if (filename && !filename.endsWith(".json")) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log("[settings] Reloading settings.json");
        loadSettings();
      }, 300);
    });
    console.log(`[settings] Watching ${SETTINGS_DIR} for changes`);
  } catch (err) {
    console.warn("[settings] Could not watch settings directory:", err);
  }
}
