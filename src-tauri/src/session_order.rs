use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static ORDER: once_cell::sync::Lazy<Mutex<Vec<String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(vec![]));

fn order_file() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".muxtunnel")
        .join("session-order.json")
}

pub fn load() {
    let path = order_file();
    let order = match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Vec<String>>(&raw) {
            Ok(v) => v,
            Err(_) => vec![],
        },
        Err(_) => vec![],
    };
    *ORDER.lock().unwrap() = order;
}

pub fn get() -> Vec<String> {
    ORDER.lock().unwrap().clone()
}

pub fn save(order: Vec<String>) {
    *ORDER.lock().unwrap() = order.clone();
    let path = order_file();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::write(&path, serde_json::to_string_pretty(&order).unwrap_or_default()) {
        log::error!("[session-order] Failed to save: {}", e);
    }
}
