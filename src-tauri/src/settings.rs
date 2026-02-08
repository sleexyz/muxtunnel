use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static SETTINGS: once_cell::sync::Lazy<Mutex<SettingsState>> =
    once_cell::sync::Lazy::new(|| {
        Mutex::new(SettingsState {
            settings: default_settings(),
            version: 0,
        })
    });

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxTunnelSettings {
    pub resolver: String,
    pub projects: ProjectsSettings,
    pub background: BackgroundSettings,
    pub terminal: TerminalSettings,
    pub window: WindowSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsSettings {
    pub ignore: Vec<String>,
    #[serde(rename = "maxDepth")]
    pub max_depth: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundSettings {
    pub image: Option<String>,
    pub size: String,
    pub opacity: f64,
    pub filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(rename = "fontSize")]
    pub font_size: u32,
    #[serde(rename = "fontFamily")]
    pub font_family: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSettings {
    pub padding: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsResponse {
    pub settings: MuxTunnelSettings,
    pub version: u32,
}

struct SettingsState {
    settings: MuxTunnelSettings,
    version: u32,
}

fn settings_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".muxtunnel")
}

fn settings_file() -> PathBuf {
    settings_dir().join("settings.json")
}

fn default_settings() -> MuxTunnelSettings {
    MuxTunnelSettings {
        resolver: "muxtunnel.projects".to_string(),
        projects: ProjectsSettings {
            ignore: vec![
                "node_modules", ".git", ".hg", ".svn", "vendor", "target", "dist", "build",
                ".cache", ".local", ".npm", ".cargo", ".rustup", ".volta",
                "Library", "Applications", ".Trash", "Music", "Movies", "Pictures", "Downloads",
                "Documents", "Desktop", "Public",
                ".docker", ".nvm", ".pyenv", ".rbenv",
                ".gradle", ".m2", ".sbt",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            max_depth: 3,
        },
        background: BackgroundSettings {
            image: None,
            size: "cover".to_string(),
            opacity: 0.15,
            filter: None,
        },
        terminal: TerminalSettings {
            font_size: 14,
            font_family: "monospace".to_string(),
        },
        window: WindowSettings { padding: 0 },
    }
}

/// Deep merge: user values override defaults, nested objects are merged recursively
fn merge_settings(
    defaults: &serde_json::Value,
    user: &serde_json::Value,
) -> serde_json::Value {
    match (defaults, user) {
        (serde_json::Value::Object(d), serde_json::Value::Object(u)) => {
            let mut result = d.clone();
            for (key, val) in u {
                if let Some(existing) = result.get(key) {
                    result.insert(key.clone(), merge_settings(existing, val));
                } else {
                    result.insert(key.clone(), val.clone());
                }
            }
            serde_json::Value::Object(result)
        }
        (_, user) => user.clone(),
    }
}

/// Expand flat dot-notation keys into nested objects
fn expand_dot_keys(obj: &serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    let mut result = serde_json::Map::new();

    for (key, value) in obj {
        if key.contains('.') {
            let parts: Vec<&str> = key.split('.').collect();
            let mut target = &mut result;
            for (i, part) in parts.iter().enumerate() {
                if i == parts.len() - 1 {
                    target.insert((*part).to_string(), value.clone());
                } else {
                    let entry = target
                        .entry((*part).to_string())
                        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
                    target = entry.as_object_mut().unwrap();
                }
            }
        } else {
            result.insert(key.clone(), value.clone());
        }
    }

    serde_json::Value::Object(result)
}

fn load_settings_inner() -> MuxTunnelSettings {
    let defaults = default_settings();
    let defaults_json = serde_json::to_value(&defaults).unwrap();

    let user_json = match fs::read_to_string(settings_file()) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(serde_json::Value::Object(obj)) => expand_dot_keys(&obj),
            _ => return defaults,
        },
        Err(_) => return defaults,
    };

    let merged = merge_settings(&defaults_json, &user_json);
    let mut settings: MuxTunnelSettings =
        serde_json::from_value(merged).unwrap_or(defaults);

    // Clamp values
    settings.background.opacity = settings.background.opacity.clamp(0.0, 1.0);
    settings.window.padding = settings.window.padding.max(0);

    settings
}

pub fn load_settings() {
    let settings = load_settings_inner();
    let mut state = SETTINGS.lock().unwrap();
    state.settings = settings;
    state.version += 1;
}

pub fn get_settings() -> SettingsResponse {
    let state = SETTINGS.lock().unwrap();
    SettingsResponse {
        settings: state.settings.clone(),
        version: state.version,
    }
}

pub fn get_background_image_path() -> Option<PathBuf> {
    let state = SETTINGS.lock().unwrap();
    let image = state.settings.background.image.as_deref()?;

    if image.starts_with("http://") || image.starts_with("https://") {
        return None;
    }

    let resolved = if image.starts_with('~') {
        dirs::home_dir()
            .unwrap_or_default()
            .join(&image[1..].trim_start_matches('/'))
    } else {
        PathBuf::from(image)
    };

    if resolved.is_file() {
        Some(resolved)
    } else {
        None
    }
}

pub fn start_watching() {
    let dir = settings_dir();
    let _ = fs::create_dir_all(&dir);

    // Initial load
    load_settings();

    // Watch for changes using a simple polling approach in a background thread
    // (notify crate is used for Claude sessions; here we use a lighter approach)
    std::thread::spawn(move || {
        use std::time::{Duration, Instant};
        let mut last_modified = fs::metadata(settings_file())
            .and_then(|m| m.modified())
            .ok();
        let mut last_check = Instant::now();

        loop {
            std::thread::sleep(Duration::from_millis(500));

            // Only check every 500ms
            if last_check.elapsed() < Duration::from_millis(500) {
                continue;
            }
            last_check = Instant::now();

            let current_modified = fs::metadata(settings_file())
                .and_then(|m| m.modified())
                .ok();

            if current_modified != last_modified {
                last_modified = current_modified;
                log::info!("[settings] Reloading settings.json");
                load_settings();
            }
        }
    });
}
