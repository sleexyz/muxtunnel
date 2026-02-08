import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Default settings registry (single source of truth) ---

interface SettingDef {
  default: any;
  description: string;
}

// Flat dot-notation registry. Nested structure is derived from this.
const SETTING_DEFS: Record<string, SettingDef> = {
  "resolver":                { default: "muxtunnel.projects",  description: "Active project resolver. Available: \"muxtunnel.projects\", \"zoxide\"" },
  "projects.ignore":         { default: [
    "node_modules", ".git", ".hg", ".svn", "vendor", "target", "dist", "build",
    ".cache", ".local", ".npm", ".cargo", ".rustup", ".volta",
    "Library", "Applications", ".Trash", "Music", "Movies", "Pictures", "Downloads",
    "Documents", "Desktop", "Public",
    ".docker", ".nvm", ".pyenv", ".rbenv",
    ".gradle", ".m2", ".sbt",
  ], description: "Directories to skip during project discovery (matched by basename)" },
  "projects.maxDepth":       { default: 3,           description: "Maximum directory depth for project scanning from $HOME" },
  "terminal.fontSize":       { default: 14,          description: "Terminal font size in pixels" },
  "terminal.fontFamily":     { default: "monospace",  description: "Terminal font family (CSS font-family value)" },
  "background.image":        { default: null,         description: "Background image URL or local file path (~ is expanded)" },
  "background.size":         { default: "cover",      description: "Background image CSS background-size" },
  "background.opacity":      { default: 0.15,         description: "Background image opacity (0-1)" },
  "background.filter":       { default: null,         description: "Background image CSS filter (e.g. \"blur(5px)\")" },
  "window.padding":          { default: 0,            description: "Padding around the terminal in pixels" },
};

// --- Build nested defaults object from flat registry ---

function buildDefaults(): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    const parts = key.split(".");
    let obj = result;
    for (let i = 0; i < parts.length - 1; i++) {
      obj[parts[i]] ??= {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = def.default;
  }
  return result;
}

const DEFAULTS = buildDefaults();

// --- Generate defaults.jsonc ---

function generateDefaultsJsonc(): string {
  const lines: string[] = [
    "// MuxTunnel Default Settings",
    "// This file is auto-generated. To override values, edit settings.json.",
    "//",
    "// Both files live in ~/.muxtunnel/",
    "{",
  ];

  const entries = Object.entries(SETTING_DEFS);
  let prevSection = "";

  for (let i = 0; i < entries.length; i++) {
    const [key, def] = entries[i];
    const section = key.split(".")[0];

    // Blank line between sections
    if (section !== prevSection && prevSection !== "") {
      lines.push("");
    }
    prevSection = section;

    lines.push(`  // ${def.description}`);
    const comma = i < entries.length - 1 ? "," : "";
    if (Array.isArray(def.default)) {
      // Pretty-print arrays with one item per line
      const items = def.default.map((v: any) => `    ${JSON.stringify(v)}`);
      lines.push(`  ${JSON.stringify(key)}: [`);
      lines.push(items.join(",\n"));
      lines.push(`  ]${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(def.default)}${comma}`);
    }
  }

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// --- Deep merge (user overrides on top of defaults) ---

function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === "object" &&
      !Array.isArray(override[key]) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

// --- Settings types ---

export interface MuxTunnelSettings {
  resolver: string;
  projects: {
    ignore: string[];
    maxDepth: number;
  };
  background: {
    image: string | null;
    size: string;
    opacity: number;
    filter: string | null;
  };
  terminal: {
    fontSize: number;
    fontFamily: string;
  };
  window: {
    padding: number;
  };
}

// --- State ---

const SETTINGS_DIR = path.join(os.homedir(), ".muxtunnel");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");
const DEFAULTS_FILE = path.join(SETTINGS_DIR, "defaults.jsonc");

let currentSettings: MuxTunnelSettings = DEFAULTS as MuxTunnelSettings;
let settingsVersion = 0;

// --- Load & validate ---

export function loadSettings(): void {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      // Support flat dot-notation keys in user settings
      const expanded = expandDotKeys(parsed);
      currentSettings = deepMerge(DEFAULTS, expanded) as MuxTunnelSettings;
    } else {
      currentSettings = DEFAULTS as MuxTunnelSettings;
    }
  } catch {
    currentSettings = DEFAULTS as MuxTunnelSettings;
  }

  // Clamp values
  if (currentSettings.background) {
    currentSettings.background.opacity = Math.max(0, Math.min(1, currentSettings.background.opacity));
  }
  if (currentSettings.window) {
    currentSettings.window.padding = Math.max(0, currentSettings.window.padding);
  }

  settingsVersion++;
}

// Expand flat dot-notation keys into nested objects
// e.g. { "terminal.fontSize": 16 } → { terminal: { fontSize: 16 } }
function expandDotKeys(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.includes(".")) {
      const parts = key.split(".");
      let target = result;
      for (let i = 0; i < parts.length - 1; i++) {
        target[parts[i]] ??= {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = value;
    } else {
      // Non-dot key — could be a nested object or scalar
      if (typeof value === "object" && value !== null && !Array.isArray(value) &&
          typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

// --- Public API ---

export function getSettings(): { settings: MuxTunnelSettings; version: number } {
  return { settings: currentSettings, version: settingsVersion };
}

export function getBackgroundImagePath(): string | null {
  const image = currentSettings.background?.image;
  if (!image) return null;

  if (image.startsWith("http://") || image.startsWith("https://")) return null;

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
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  } catch {
    // Already exists
  }

  // Write defaults.jsonc (readonly documentation)
  try {
    fs.writeFileSync(DEFAULTS_FILE, generateDefaultsJsonc());
    console.log(`[settings] Wrote ${DEFAULTS_FILE}`);
  } catch (err) {
    console.warn("[settings] Could not write defaults.jsonc:", err);
  }

  // Initial load
  loadSettings();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    fs.watch(SETTINGS_DIR, (_event, filename) => {
      if (filename !== "settings.json") return;

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
