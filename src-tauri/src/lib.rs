//! Tauri application assembly: plugins, native menu, state and command registration.

pub mod ai;
pub mod commands;
pub mod connections;
pub mod db;
pub mod error;
pub mod history;
pub mod menu;
pub mod secrets;
pub mod sql_split;
pub mod updates;

use tauri::Manager;

use ai::AiState;
use commands::AppState;
use connections::ConnectionStore;
use db::ConnectionManager;
use history::History;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            app.manage(AiState::new());
            app.set_menu(menu::build(handle)?)?;
            app.on_menu_event(menu::handle_event);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai::commands::ai_key_status,
            ai::commands::ai_set_key,
            ai::commands::ai_delete_key,
            ai::commands::ai_list_models,
            ai::commands::ai_chat,
            ai::commands::ai_cancel,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_databases,
            commands::list_tables,
            commands::list_keys,
            commands::list_columns,
            commands::list_indexes,
            commands::list_foreign_keys,
            commands::get_table_ddl,
            commands::execute_query,
            commands::cancel_query,
            commands::export_query,
            commands::export_rows,
            commands::count_query,
            commands::apply_changes,
            commands::close_session,
            commands::list_history,
            commands::clear_history,
            menu::set_theme_menu,
            updates::update_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
