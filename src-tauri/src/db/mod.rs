//! Database-agnostic layer: the `Driver` / `Session` traits every backend
//! implements, the shared metadata and result types, and the factory that
//! picks a backend by `DbKind`.
//!
//! The rest of the application (Tauri commands, the connection manager, the
//! execution loop) only talks to these traits; everything vendor-specific
//! lives in the per-backend submodules.

pub mod clickhouse;
pub mod execute;
pub mod json;
pub mod manager;
pub mod mysql;
pub mod postgres;
pub mod schema;
pub mod sqlite;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::connections::StoredConnectionView;
use crate::error::{AppError, AppResult};

pub use manager::ConnectionManager;
pub use schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo, TableKind};

/// Supported database engines. Serialized in lowercase — the same strings the
/// frontend uses (`src/api/types.ts`, `DbKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    #[default]
    Mysql,
    Mariadb,
    Postgres,
    Clickhouse,
    Sqlite,
}

impl DbKind {
    /// Human-readable product name.
    pub fn label(self) -> &'static str {
        match self {
            DbKind::Mysql => "MySQL",
            DbKind::Mariadb => "MariaDB",
            DbKind::Postgres => "PostgreSQL",
            DbKind::Clickhouse => "ClickHouse",
            DbKind::Sqlite => "SQLite",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub server_version: String,
    /// Backend-side id of the session that reported the version (MySQL
    /// `CONNECTION_ID()`, PostgreSQL `pg_backend_pid()`), when the engine has one.
    pub connection_id: Option<u64>,
}

/// A cell value in JSON: null | number | string | boolean (the `CellValue` contract).
pub type CellValue = serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub table: Option<String>,
    pub database: Option<String>,
    /// Uppercase engine type name, e.g. "VARCHAR", "INT", "DATETIME", "JSON".
    pub type_name: String,
    pub unsigned: bool,
    pub nullable: bool,
    pub primary_key: bool,
    pub binary: bool,
}

impl ColumnMeta {
    /// Column metadata for engines that only report a name and a type.
    pub fn simple(name: impl Into<String>, type_name: impl Into<String>, nullable: bool) -> Self {
        Self {
            name: name.into(),
            table: None,
            database: None,
            type_name: type_name.into(),
            unsigned: false,
            nullable,
            primary_key: false,
            binary: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatementResultKind {
    Rows,
    Affected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    pub sql: String,
    pub kind: StatementResultKind,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<CellValue>>,
    pub truncated: bool,
    pub affected_rows: u64,
    pub last_insert_id: Option<u64>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

impl StatementResult {
    /// A result set. `duration_ms` is filled in by the execution loop.
    pub fn rows(sql: &str, columns: Vec<ColumnMeta>, rows: Vec<Vec<CellValue>>, truncated: bool) -> Self {
        Self {
            sql: sql.to_string(),
            kind: StatementResultKind::Rows,
            columns,
            rows,
            truncated,
            affected_rows: 0,
            last_insert_id: None,
            error: None,
            duration_ms: 0,
        }
    }

    /// A statement without a result set (INSERT/UPDATE/DELETE/DDL).
    pub fn affected(sql: &str, affected_rows: u64, last_insert_id: Option<u64>) -> Self {
        Self {
            sql: sql.to_string(),
            kind: StatementResultKind::Affected,
            columns: vec![],
            rows: vec![],
            truncated: false,
            affected_rows,
            last_insert_id,
            error: None,
            duration_ms: 0,
        }
    }

    pub fn error(sql: &str, message: String, duration_ms: u64) -> Self {
        Self {
            sql: sql.to_string(),
            kind: StatementResultKind::Error,
            columns: vec![],
            rows: vec![],
            truncated: false,
            affected_rows: 0,
            last_insert_id: None,
            error: Some(message),
            duration_ms,
        }
    }
}

/// A statement with positional `?` placeholders (the frontend's data-editing contract).
/// Backends whose native placeholder syntax differs (PostgreSQL `$n`) rewrite it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamStatement {
    pub sql: String,
    pub params: Vec<CellValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub affected_rows: u64,
    pub duration_ms: u64,
}

/// What a backend needs to cancel a statement that is running on a session.
/// Captured *before* the statement starts (see `execute::execute`), so every
/// variant must identify the session rather than a particular statement.
#[derive(Clone)]
pub enum CancelHandle {
    /// The engine cannot cancel a running statement.
    None,
    /// `KILL QUERY <thread id>` on a utility connection.
    MysqlThread(u32),
    /// The cancel request protocol; carries the backend pid and secret key.
    Postgres(tokio_postgres::CancelToken),
    /// `KILL QUERY WHERE query_id = ...` over HTTP.
    ClickhouseQuery(String),
    /// `sqlite3_interrupt` on the session's connection.
    Sqlite(std::sync::Arc<rusqlite::InterruptHandle>),
}

/// A dedicated connection owned by one console / data tab. Statements on a
/// session run strictly one after another (the manager wraps it in a mutex).
#[async_trait]
pub trait Session: Send {
    /// Handle that cancels whatever is currently running on this session.
    fn cancel_handle(&self) -> CancelHandle;

    /// Runs a single statement and returns one `StatementResult` per result
    /// set (kind `Rows` or `Affected`; `duration_ms` is left at zero). Rows
    /// beyond `max_rows` are discarded and the result is marked `truncated`.
    /// A failing statement is returned as `Err` — the execution loop turns it
    /// into a `StatementResult` of kind `Error`.
    async fn run(&mut self, sql: &str, max_rows: usize) -> AppResult<Vec<StatementResult>>;

    /// Executes parameterized statements in a single transaction and returns
    /// the total affected-row count. Rolls back and returns `Err` on the first failure.
    async fn apply(&mut self, statements: &[ParamStatement]) -> AppResult<u64>;

    /// Whether the underlying connection is still usable. A dead session is
    /// transparently recreated by the manager.
    async fn is_alive(&mut self) -> bool;
}

/// One open connection configuration: a metadata connection (or pool) plus the
/// ability to open per-tab sessions and to cancel their statements.
#[async_trait]
pub trait Driver: Send + Sync {
    fn kind(&self) -> DbKind;

    async fn server_info(&self) -> AppResult<ServerInfo>;

    /// Opens a dedicated session, positioned on `database` when given
    /// (`USE` / `search_path` / HTTP `database` parameter, depending on the engine).
    async fn open_session(&self, database: Option<&str>) -> AppResult<Box<dyn Session>>;

    /// Cancels the statement identified by `handle`. Must not fail when the
    /// statement has already finished.
    async fn cancel(&self, handle: &CancelHandle) -> AppResult<()>;

    /// Top-level namespaces shown under the connection in the explorer:
    /// databases for MySQL/ClickHouse, schemas of the connected database for
    /// PostgreSQL, attached databases for SQLite.
    async fn list_databases(&self) -> AppResult<Vec<String>>;
    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>>;
    async fn list_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>>;
    async fn list_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>>;
    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>>;
    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String>;

    /// Releases the metadata connection / pool. Sessions are dropped by the manager.
    async fn close(&self);
}

/// Opens the backend selected by `config.kind`.
pub async fn open_driver(config: &StoredConnectionView, password: Option<String>) -> AppResult<Box<dyn Driver>> {
    Ok(match config.kind {
        DbKind::Mysql | DbKind::Mariadb => Box::new(mysql::MysqlDriver::connect(config, password).await?),
        DbKind::Postgres => Box::new(postgres::PostgresDriver::connect(config, password).await?),
        DbKind::Clickhouse => return Err(AppError::Other("ClickHouse support is not implemented yet".into())),
        DbKind::Sqlite => return Err(AppError::Other("SQLite support is not implemented yet".into())),
    })
}

/// Tests a connection without keeping any state: opens the backend, asks for
/// the server version and closes it right away.
pub async fn test_connection(config: &StoredConnectionView, password: Option<String>) -> AppResult<ServerInfo> {
    let driver = open_driver(config, password).await?;
    let info = driver.server_info().await;
    driver.close().await;
    info
}

#[cfg(test)]
mod tests {
    use super::DbKind;

    #[test]
    fn db_kind_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&DbKind::Postgres).unwrap(), "\"postgres\"");
        assert_eq!(
            serde_json::from_str::<DbKind>("\"clickhouse\"").unwrap(),
            DbKind::Clickhouse
        );
    }

    #[test]
    fn db_kind_defaults_to_mysql() {
        assert_eq!(DbKind::default(), DbKind::Mysql);
    }
}
