import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { getSettings } from "./settings.js";

const execFileAsync = promisify(execFileCb);

// --- Types ---

export interface ProjectResult {
  name: string;
  path: string;
  score: number;
}

export interface ProjectResolver {
  id: string;
  resolve(query: string): Promise<ProjectResult[]>;
  resolveOne(name: string): Promise<{ name: string; path: string } | null>;
  recordSelection(projectPath: string): void;
}

// --- Frecency ---

const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;

interface HistoryEntry {
  rank: number;
  lastAccessed: number;
}

type HistoryDB = Record<string, HistoryEntry>;

const MUXTUNNEL_DIR = path.join(os.homedir(), ".muxtunnel");
const HISTORY_FILE = path.join(MUXTUNNEL_DIR, "history.json");

function loadHistory(): HistoryDB {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveHistory(db: HistoryDB): void {
  try {
    fs.mkdirSync(MUXTUNNEL_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("[resolver] Failed to save history:", err);
  }
}

function frecencyScore(entry: HistoryEntry, now: number): number {
  const elapsed = now - entry.lastAccessed;
  if (elapsed < HOUR) return entry.rank * 4;
  if (elapsed < DAY) return entry.rank * 2;
  if (elapsed < WEEK) return entry.rank * 0.5;
  return entry.rank * 0.25;
}

// --- Project Discovery ---

function discoverProjects(): string[] {
  const { settings } = getSettings();
  const ignore = new Set(settings.projects.ignore);
  const maxDepth = settings.projects.maxDepth;

  const home = os.homedir();
  const projects: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check if this dir has a .git — it's a project
    try {
      fs.accessSync(path.join(dir, ".git"));
      projects.push(dir);
      return; // don't recurse into project subdirs
    } catch {
      // not a project, keep looking
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".config") continue;
      if (ignore.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(home, 0);
  return projects;
}

let discoveredProjects: string[] | null = null;
let lastScanTime = 0;
const RESCAN_INTERVAL = 5 * 60 * 1000;

function getDiscoveredProjects(): string[] {
  const now = Date.now();
  if (!discoveredProjects || now - lastScanTime > RESCAN_INTERVAL) {
    const start = Date.now();
    discoveredProjects = discoverProjects();
    console.log(`[resolver] Discovered ${discoveredProjects.length} projects in ${Date.now() - start}ms`);
    lastScanTime = now;
  }
  return discoveredProjects;
}

// --- Built-in resolver: muxtunnel.projects ---

function createProjectsResolver(): ProjectResolver {
  // Trigger initial scan on next tick
  setTimeout(() => getDiscoveredProjects(), 0);

  return {
    id: "muxtunnel.projects",

    async resolve(query: string): Promise<ProjectResult[]> {
      const history = loadHistory();
      const discovered = getDiscoveredProjects();
      const now = Math.floor(Date.now() / 1000);
      const lq = query.toLowerCase();

      const seen = new Set<string>();
      const results: ProjectResult[] = [];

      // History entries (have frecency)
      for (const [projectPath, entry] of Object.entries(history)) {
        seen.add(projectPath);
        const name = path.basename(projectPath);
        if (lq && !name.toLowerCase().includes(lq) && !projectPath.toLowerCase().includes(lq)) continue;
        results.push({ name, path: projectPath, score: frecencyScore(entry, now) });
      }

      // Discovered projects not in history (cold-start fallback)
      for (const projectPath of discovered) {
        if (seen.has(projectPath)) continue;
        const name = path.basename(projectPath);
        if (lq && !name.toLowerCase().includes(lq) && !projectPath.toLowerCase().includes(lq)) continue;
        results.push({ name, path: projectPath, score: 0.1 });
      }

      results.sort((a, b) => b.score - a.score);
      return results;
    },

    async resolveOne(name: string): Promise<{ name: string; path: string } | null> {
      const results = await this.resolve(name);
      return results.length > 0 ? { name: results[0].name, path: results[0].path } : null;
    },

    recordSelection(projectPath: string): void {
      const history = loadHistory();
      const now = Math.floor(Date.now() / 1000);
      const entry = history[projectPath];
      if (entry) {
        entry.rank += 1;
        entry.lastAccessed = now;
      } else {
        history[projectPath] = { rank: 1, lastAccessed: now };
      }
      saveHistory(history);
    },
  };
}

// --- Zoxide resolver ---

function createZoxideResolver(): ProjectResolver {
  return {
    id: "zoxide",

    async resolve(query: string): Promise<ProjectResult[]> {
      try {
        const args = ["query", "--list", "--score"];
        if (query) args.push("--", query);
        const { stdout } = await execFileAsync("zoxide", args, { encoding: "utf-8" });
        return stdout.trim().split("\n").filter(Boolean).map((line) => {
          const match = line.trim().match(/^\s*([\d.]+)\s+(.+)$/);
          if (!match) return null;
          return { score: parseFloat(match[1]), path: match[2], name: path.basename(match[2]) };
        }).filter(Boolean) as ProjectResult[];
      } catch {
        return [];
      }
    },

    async resolveOne(name: string): Promise<{ name: string; path: string } | null> {
      try {
        const { stdout } = await execFileAsync("zoxide", ["query", "--", name], { encoding: "utf-8" });
        const resolved = stdout.trim();
        if (!resolved) return null;
        return { name: path.basename(resolved), path: resolved };
      } catch {
        return null;
      }
    },

    recordSelection(_projectPath: string): void {
      // zoxide manages its own frecency via shell hooks
    },
  };
}

// --- Resolver manager ---

const resolvers = new Map<string, ProjectResolver>();
let activeResolver: ProjectResolver;

export function getResolver(): ProjectResolver {
  return activeResolver;
}

export function getAvailableResolvers(): string[] {
  return Array.from(resolvers.keys());
}

export async function initResolvers(resolverSetting?: string): Promise<void> {
  const projects = createProjectsResolver();
  resolvers.set(projects.id, projects);

  try {
    await execFileAsync("zoxide", ["--version"]);
    resolvers.set("zoxide", createZoxideResolver());
    console.log("[resolver] zoxide available");
  } catch {
    console.log("[resolver] zoxide not found");
  }

  if (resolverSetting && resolvers.has(resolverSetting)) {
    activeResolver = resolvers.get(resolverSetting)!;
  } else {
    activeResolver = projects;
  }
  console.log(`[resolver] Active: ${activeResolver.id}`);
}
