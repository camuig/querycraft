//! Tauri application assembly: plugins, native menu, state and command registration.

pub mod commands;
pub mod connections;
pub mod error;
pub mod history;
pub mod menu;
pub mod mysql;
pub mod sql_split;

use tauri::Manager;

use commands::AppState;
use connections::ConnectionStore;
use history::History;
use mysql::ConnectionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            let handle = app.handle();
            let connections = ConnectionStore::load(handle)?;
            let history = History::load(handle)?;
            let manager = ConnectionManager::new();
            app.manage(AppState {
                connections,
                manager,
                history,
            });
            app.set_menu(menu::build(handle)?)?;
            app.on_menu_event(menu::handle_event);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_databases,
            commands::list_tables,
            commands::list_columns,
            commands::list_indexes,
            commands::list_foreign_keys,
            commands::get_table_ddl,
            commands::execute_query,
            commands::cancel_query,
            commands::apply_changes,
            commands::close_session,
            commands::list_history,
            commands::clear_history,
            menu::set_theme_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
