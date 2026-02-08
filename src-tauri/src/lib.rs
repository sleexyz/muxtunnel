mod claude_sessions;
mod commands;
mod pty_manager;
mod resolver;
mod session_order;
mod settings;
mod tmux;

use std::sync::Arc;
use tokio::sync::Mutex;

/// Shared application state managed by Tauri
pub struct AppState {
    pub pty_sessions: Arc<Mutex<pty_manager::PtySessionMap>>,
}

pub fn run() {
    env_logger::init();

    let state = AppState {
        pty_sessions: Arc::new(Mutex::new(pty_manager::PtySessionMap::new())),
    };

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Start Claude session watching in background
            tauri::async_runtime::spawn(async move {
                claude_sessions::start_watching(app_handle).await;
            });

            // Start settings watching
            settings::start_watching();

            // Load session order
            session_order::load();

            // Init resolvers
            let resolver_setting = settings::get_settings().settings.resolver.clone();
            resolver::init(&resolver_setting);

            log::info!("MuxTunnel native app initialized");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sessions_list,
            commands::sessions_create,
            commands::sessions_delete,
            commands::panes_delete,
            commands::panes_input,
            commands::panes_interrupt,
            commands::projects_list,
            commands::projects_resolve,
            commands::claude_mark_viewed,
            commands::session_order_get,
            commands::session_order_save,
            commands::settings_get,
            commands::pty_connect,
            commands::pty_send,
            commands::pty_close,
            commands::asset_background,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MuxTunnel");
}
