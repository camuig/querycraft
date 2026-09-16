//! Thin `#[tauri::command]` wrappers — one-to-one with the list in `src/api/commands.ts`.

use tauri::State;

use crate::connections::{ConnectionConfig, ConnectionInput, ConnectionStore};
use crate::db::execute::{self, ExecuteRequest, ExportRequest};
use crate::db::export::{self, ExportSummary, RowsExportRequest};
use crate::db::{
    ApplyResult, ColumnInfo, ConnectionManager, ForeignKeyInfo, IndexInfo, ParamStatement, ServerInfo, StatementResult,
    TableInfo,
};
use crate::error::AppResult;
use crate::history::{History, QueryHistoryEntry};

pub struct AppState {
    pub connections: ConnectionStore,
    pub manager: ConnectionManager,
    pub history: History,
}

// --- Connections -----------------------------------------------------------

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

/// Tests a connection without saving it.
#[tauri::command]
pub async fn test_connection(input: ConnectionInput) -> AppResult<ServerInfo> {
    ConnectionManager::test_connection(&input.to_view(), input.credentials()).await
}

/// Opens the driver for a connection (required before any queries).
#[tauri::command]
pub async fn connect(state: State<'_, AppState>, connection_id: String) -> AppResult<ServerInfo> {
    let config = state.connections.get_stored(&connection_id)?;
    let credentials = state.connections.get_credentials(&connection_id);
    state.manager.connect(&connection_id, &config, credentials).await
}

/// Closes the driver and all sessions for a connection.
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, connection_id: String) -> AppResult<()> {
    state.manager.disconnect(&connection_id).await
}

// --- Schema -------------------------------------------------------------------

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, connection_id: String) -> AppResult<Vec<String>> {
    state.manager.driver(&connection_id)?.list_databases().await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> AppResult<Vec<TableInfo>> {
    state.manager.driver(&connection_id)?.list_tables(&database).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    state
        .manager
        .driver(&connection_id)?
        .list_columns(&database, &table)
        .await
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    state
        .manager
        .driver(&connection_id)?
        .list_indexes(&database, &table)
        .await
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> AppResult<Vec<ForeignKeyInfo>> {
    state
        .manager
        .driver(&connection_id)?
        .list_foreign_keys(&database, &table)
        .await
}

#[tauri::command]
pub async fn get_table_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    table: String,
) -> AppResult<String> {
    state.manager.driver(&connection_id)?.table_ddl(&database, &table).await
}

// --- Execution ----------------------------------------------------------------

/// Splits sql into statements and executes them sequentially in the session.
#[tauri::command]
pub async fn execute_query(state: State<'_, AppState>, request: ExecuteRequest) -> AppResult<Vec<StatementResult>> {
    execute::execute(&state.manager, &state.history, request).await
}

/// Re-runs a statement without the row limit and writes the whole result set to a file.
#[tauri::command]
pub async fn export_query(state: State<'_, AppState>, request: ExportRequest) -> AppResult<ExportSummary> {
    execute::export(&state.manager, request).await
}

/// Writes rows the frontend already holds (the grid contents) to a file.
#[tauri::command]
pub async fn export_rows(request: RowsExportRequest) -> AppResult<ExportSummary> {
    tokio::task::spawn_blocking(move || export::export_rows(request))
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?
}

/// Cancels the statement started with this queryId (KILL QUERY, pg_cancel, ...).
#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, connection_id: String, query_id: String) -> AppResult<()> {
    state.manager.cancel_query(&connection_id, &query_id).await
}

/// Executes parameterized statements in a single transaction (data editing).
#[tauri::command]
pub async fn apply_changes(
    state: State<'_, AppState>,
    connection_id: String,
    session_id: String,
    statements: Vec<ParamStatement>,
) -> AppResult<ApplyResult> {
    execute::apply_changes(&state.manager, &connection_id, &session_id, statements).await
}

/// Closes the session connection (when a tab is closed).
#[tauri::command]
pub async fn close_session(state: State<'_, AppState>, connection_id: String, session_id: String) -> AppResult<()> {
    state.manager.close_session(&connection_id, &session_id).await
}

// --- History -----------------------------------------------------------------

#[tauri::command]
pub async fn list_history(state: State<'_, AppState>, limit: usize) -> AppResult<Vec<QueryHistoryEntry>> {
    Ok(state.history.list(limit))
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> AppResult<()> {
    state.history.clear()
}
