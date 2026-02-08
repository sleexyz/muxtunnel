use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static RESOLVER_STATE: once_cell::sync::Lazy<Mutex<ResolverState>> =
    once_cell::sync::Lazy::new(|| Mutex::new(ResolverState::default()));

#[derive(Debug, Clone, Serialize)]
pub struct ProjectResult {
    pub name: String,
    pub path: String,
    pub score: f64,
}

#[derive(Default)]
struct ResolverState {
    active_resolver: String,
    discovered_projects: Vec<String>,
    last_scan_time: u64,
    zoxide_available: bool,
}

const HOUR: u64 = 3600;
const DAY: u64 = 86400;
const WEEK: u64 = 604800;
const RESCAN_INTERVAL_MS: u64 = 5 * 60 * 1000;

fn muxtunnel_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".muxtunnel")
}

fn history_file() -> PathBuf {
    muxtunnel_dir().join("history.json")
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct HistoryEntry {
    rank: f64,
    #[serde(rename = "lastAccessed")]
    last_accessed: u64,
}

type HistoryDB = HashMap<String, HistoryEntry>;

fn load_history() -> HistoryDB {
    match fs::read_to_string(history_file()) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_history(db: &HistoryDB) {
    let dir = muxtunnel_dir();
    let _ = fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_string_pretty(db) {
        if let Err(e) = fs::write(history_file(), json) {
            log::error!("[resolver] Failed to save history: {}", e);
        }
    }
}

fn frecency_score(entry: &HistoryEntry, now: u64) -> f64 {
    let elapsed = now.saturating_sub(entry.last_accessed);
    if elapsed < HOUR {
        entry.rank * 4.0
    } else if elapsed < DAY {
        entry.rank * 2.0
    } else if elapsed < WEEK {
        entry.rank * 0.5
    } else {
        entry.rank * 0.25
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Discover projects by walking $HOME
fn discover_projects() -> Vec<String> {
    let settings = super::settings::get_settings();
    let ignore: std::collections::HashSet<String> =
        settings.settings.projects.ignore.into_iter().collect();
    let max_depth = settings.settings.projects.max_depth;

    let home = dirs::home_dir().unwrap_or_default();
    let mut projects = Vec::new();

    fn walk(
        dir: &Path,
        depth: u32,
        max_depth: u32,
        ignore: &std::collections::HashSet<String>,
        projects: &mut Vec<String>,
    ) {
        if depth > max_depth {
            return;
        }

        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        // Check if this dir has .git
        if dir.join(".git").exists() {
            projects.push(dir.to_string_lossy().to_string());
            return; // Don't recurse into project subdirs
        }

        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') && name_str != ".config" {
                continue;
            }
            if ignore.contains(name_str.as_ref()) {
                continue;
            }
            walk(&entry.path(), depth + 1, max_depth, ignore, projects);
        }
    }

    walk(&home, 0, max_depth, &ignore, &mut projects);
    projects
}

fn get_discovered_projects(state: &mut ResolverState) -> &[String] {
    let now = now_millis();
    if state.discovered_projects.is_empty() || now - state.last_scan_time > RESCAN_INTERVAL_MS {
        let start = std::time::Instant::now();
        state.discovered_projects = discover_projects();
        log::info!(
            "[resolver] Discovered {} projects in {:?}",
            state.discovered_projects.len(),
            start.elapsed()
        );
        state.last_scan_time = now;
    }
    &state.discovered_projects
}

/// Resolve projects using the built-in resolver
fn resolve_builtin(query: &str) -> Vec<ProjectResult> {
    let mut state = RESOLVER_STATE.lock().unwrap();
    let history = load_history();
    let now = now_unix();
    let lq = query.to_lowercase();

    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::new();

    // History entries
    for (project_path, entry) in &history {
        seen.insert(project_path.clone());
        let name = Path::new(project_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if !lq.is_empty()
            && !name.to_lowercase().contains(&lq)
            && !project_path.to_lowercase().contains(&lq)
        {
            continue;
        }
        results.push(ProjectResult {
            name,
            path: project_path.clone(),
            score: frecency_score(entry, now),
        });
    }

    // Discovered projects not in history
    let discovered = get_discovered_projects(&mut state).to_vec();
    for project_path in &discovered {
        if seen.contains(project_path) {
            continue;
        }
        let name = Path::new(project_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if !lq.is_empty()
            && !name.to_lowercase().contains(&lq)
            && !project_path.to_lowercase().contains(&lq)
        {
            continue;
        }
        results.push(ProjectResult {
            name,
            path: project_path.clone(),
            score: 0.1,
        });
    }

    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results
}

/// Resolve projects using zoxide
async fn resolve_zoxide(query: &str) -> Vec<ProjectResult> {
    let mut args = vec!["query", "--list", "--score"];
    if !query.is_empty() {
        args.push("--");
        args.push(query);
    }

    let output = match tokio::process::Command::new("zoxide")
        .args(&args)
        .output()
        .await
    {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let trimmed = line.trim();
            let mut parts = trimmed.splitn(2, char::is_whitespace);
            let score: f64 = parts.next()?.trim().parse().ok()?;
            let path = parts.next()?.trim().to_string();
            let name = Path::new(&path)
                .file_name()?
                .to_string_lossy()
                .to_string();
            Some(ProjectResult { name, path, score })
        })
        .collect()
}

/// Resolve a single name using zoxide
async fn resolve_one_zoxide(name: &str) -> Option<ProjectResult> {
    let output = tokio::process::Command::new("zoxide")
        .args(["query", "--", name])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if resolved.is_empty() {
        return None;
    }

    let proj_name = Path::new(&resolved)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Some(ProjectResult {
        name: proj_name,
        path: resolved,
        score: 1.0,
    })
}

pub fn record_selection(project_path: &str) {
    let state = RESOLVER_STATE.lock().unwrap();
    if state.active_resolver == "zoxide" {
        return; // zoxide manages its own frecency
    }
    drop(state);

    let mut history = load_history();
    let now = now_unix();
    let entry = history
        .entry(project_path.to_string())
        .or_insert(HistoryEntry {
            rank: 0.0,
            last_accessed: now,
        });
    entry.rank += 1.0;
    entry.last_accessed = now;
    save_history(&history);
}

pub fn init(resolver_setting: &str) {
    let mut state = RESOLVER_STATE.lock().unwrap();

    // Check zoxide availability
    state.zoxide_available = std::process::Command::new("zoxide")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if state.zoxide_available {
        log::info!("[resolver] zoxide available");
    } else {
        log::info!("[resolver] zoxide not found");
    }

    if resolver_setting == "zoxide" && state.zoxide_available {
        state.active_resolver = "zoxide".to_string();
    } else {
        state.active_resolver = "muxtunnel.projects".to_string();
    }

    log::info!("[resolver] Active: {}", state.active_resolver);
}

pub async fn resolve(query: &str) -> Vec<ProjectResult> {
    let resolver = {
        let state = RESOLVER_STATE.lock().unwrap();
        state.active_resolver.clone()
    };

    match resolver.as_str() {
        "zoxide" => resolve_zoxide(query).await,
        _ => resolve_builtin(query),
    }
}

pub async fn resolve_one(name: &str) -> Option<ProjectResult> {
    let resolver = {
        let state = RESOLVER_STATE.lock().unwrap();
        state.active_resolver.clone()
    };

    match resolver.as_str() {
        "zoxide" => resolve_one_zoxide(name).await,
        _ => {
            let results = resolve_builtin(name);
            results.into_iter().next()
        }
    }
}
