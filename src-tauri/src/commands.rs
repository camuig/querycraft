//! Тонкие `#[tauri::command]` обёртки — один в один со списком в `src/api/commands.ts`.

use tauri::State;

use crate::connections::{ConnectionConfig, ConnectionInput, ConnectionStore, StoredConnectionView};
use crate::error::AppResult;
use crate::history::{History, QueryHistoryEntry};
use crate::mysql::execute::{self, ApplyResult, ExecuteRequest, ParamStatement, StatementResult};
use crate::mysql::schema::{self, ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo};
use crate::mysql::{ConnectionManager, ServerInfo};

pub struct AppState {
    pub connections: ConnectionStore,
    pub manager: ConnectionManager,
    pub history: History,
}

// --- Подключения -----------------------------------------------------------

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionConfig>> {
    state.connections.list()
}

#[tauri::command]
pub async fn save_connection(state: State<'_, AppState>, input: ConnectionInput) -> AppResult<ConnectionConfig> {
    state.connections.save(input)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.connections.delete(&id)
}

/// Проверка подключения без сохранения.
#[tauri::command]
pub async fn test_connection(input: ConnectionInput) -> AppResult<ServerInfo> {
    let view = StoredConnectionView {
        host: input.host,
        port: input.port,
        user: input.user,
        database: input.database,
        ssl: input.ssl,
    };
    ConnectionManager::test_connection(&view, input.password).await
}

/// Открыть пул соединений для подключения (нужно перед любыми запросами).
#[tauri::command]
pub async fn connect(state: State<'_, AppState>, connection_id: String) -> AppResult<ServerInfo> {
    let config = state.connections.get_stored(&connection_id)?;
    let password = state.connections.get_password(&connection_id)?;
    state.manager.connect(&connection_id, &config, password).await
}

/// Закрыть пул и все сессии подключения.
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, connection_id: String) -> AppResult<()> {
    state.manager.disconnect(&connection_id).await
}

// --- Схема -------------------------------------------------------------------

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, connection_id: String) -> AppResult<Vec<String>> {
    let mut conn = state.manager.metadata_conn(&connection_id).await?;
    schema::list_databases(&mut conn).await
}

#[tauri::command]
pub async fn list_tables(state: State<'_, AppState>, connection_id: String, database: String) -> AppResult<Vec<TableInfo>> {
    let mut conn = state.manager.metadata_conn(&connection_id).await?;
    schema::list_tables(&mut conn, &database).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    let mut conn = state.manager.metadata_conn(&connection_id).await?;
    schema::list_columns(&mut conn, &database, &table).await
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    let mut conn = state.manager.metadata_conn(&connection_id).await?;
    schema::list_indexes(&mut conn, &database, &table).await
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> AppResult<Vec<ForeignKeyInfo>> {
    let mut conn = state.manager.metadata_conn(&connection_id).await?;
    schema::list_foreign_keys(&mut conn, &database, &table).await
}

#[tauri::command]
pub async fn get_table_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> AppResult<String> {
    let mut conn = state.manager.metadata_conn(&connection_id).await?;
    schema::get_table_ddl(&mut conn, &database, &table).await
}

// --- Выполнение ----------------------------------------------------------------

/// Разбивает sql на выражения и выполняет их последовательно в сессии.
#[tauri::command]
pub async fn execute_query(state: State<'_, AppState>, request: ExecuteRequest) -> AppResult<Vec<StatementResult>> {
    execute::execute(&state.manager, &state.history, request).await
}

/// KILL QUERY для запроса, запущенного с этим queryId.
#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, connection_id: String, query_id: String) -> AppResult<()> {
    state.manager.cancel_query(&connection_id, &query_id).await
}

/// Выполнить параметризованные выражения в одной транзакции (редактирование данных).
#[tauri::command]
pub async fn apply_changes(
    state: State<'_, AppState>,
    connection_id: String,
    session_id: String,
    statements: Vec<ParamStatement>,
) -> AppResult<ApplyResult> {
    execute::apply_changes(&state.manager, &connection_id, &session_id, statements).await
}

/// Закрыть соединение сессии (при закрытии вкладки).
#[tauri::command]
pub async fn close_session(state: State<'_, AppState>, connection_id: String, session_id: String) -> AppResult<()> {
    state.manager.close_session(&connection_id, &session_id).await
}

// --- История -----------------------------------------------------------------

#[tauri::command]
pub async fn list_history(state: State<'_, AppState>, limit: usize) -> AppResult<Vec<QueryHistoryEntry>> {
    Ok(state.history.list(limit))
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> AppResult<()> {
    state.history.clear()
}
