//! SQLite backend on `rusqlite`. There is no network round trip and no
//! server process: the driver keeps one connection for metadata queries and
//! opens a dedicated connection per session (tab), all to the same file, so
//! tabs never block each other. `rusqlite::Connection` is blocking and not
//! `Sync`, so every connection is wrapped in a `Mutex` and every call runs on
//! a `spawn_blocking` worker thread via the `with_conn` helper below.

pub mod convert;
pub mod schema;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rusqlite::{Connection, InterruptHandle, OpenFlags};

use crate::connections::StoredConnectionView;
use crate::error::{AppError, AppResult};

use super::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo};
use super::{
    CancelHandle, CellValue, ColumnMeta, DbKind, Driver, ParamStatement, ServerInfo, Session, StatementResult,
};
use convert::{is_insert_statement, json_to_value, storage_class, value_ref_to_json};

/// Applied to every connection so a writer waiting on another tab's
/// transaction fails gracefully instead of returning `SQLITE_BUSY` immediately.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

fn open_flags() -> OpenFlags {
    OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
}

/// A plain `:memory:` database is private to the connection that opened it;
/// a shared-cache URI lets every session (tab) see the same in-memory database
/// for as long as the driver's metadata connection keeps it alive.
const SHARED_MEMORY_URI: &str = "file:querycraft-memory?mode=memory&cache=shared";

fn connection_target(path: &str) -> &str {
    if path == ":memory:" {
        SHARED_MEMORY_URI
    } else {
        path
    }
}

/// Opens one connection to `path` with the settings every session needs:
/// a busy timeout (tabs share the same file) and enforced foreign keys
/// (off by default in SQLite, unlike every other engine we support).
fn open_connection(path: &str) -> AppResult<Connection> {
    let conn = Connection::open_with_flags(connection_target(path), open_flags())?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute("PRAGMA foreign_keys = ON", [])?;
    Ok(conn)
}

async fn open_connection_blocking(path: String) -> AppResult<Connection> {
    tokio::task::spawn_blocking(move || open_connection(&path))
        .await
        .map_err(|e| AppError::Other(format!("SQLite worker task failed: {e}")))?
}

/// Runs a blocking closure against a shared connection on a worker thread.
/// Every `rusqlite` call is synchronous, so this is how the async `Driver`/
/// `Session` methods reach it without blocking the tokio runtime.
async fn with_conn<T, F>(conn: &Arc<Mutex<Connection>>, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> AppResult<T> + Send + 'static,
{
    let conn = conn.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut conn)
    })
    .await
    .map_err(|e| AppError::Other(format!("SQLite worker task failed: {e}")))?
}

pub struct SqliteDriver {
    /// The database file (or `:memory:`), reopened for every session.
    path: String,
    /// The metadata connection, used for `server_info` and schema queries.
    conn: Arc<Mutex<Connection>>,
}

impl SqliteDriver {
    pub async fn connect(config: &StoredConnectionView) -> AppResult<Self> {
        let path = config
            .path
            .clone()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| AppError::Other("SQLite connection requires a database file path".into()))?;
        let conn = open_connection_blocking(path.clone()).await?;
        Ok(Self {
            path,
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

#[async_trait]
impl Driver for SqliteDriver {
    fn kind(&self) -> DbKind {
        DbKind::Sqlite
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let server_version = with_conn(&self.conn, |conn| {
            Ok(conn.query_row("SELECT sqlite_version()", [], |row| row.get(0))?)
        })
        .await?;
        Ok(ServerInfo {
            server_version,
            connection_id: None,
        })
    }

    /// SQLite sessions are always positioned on `main`; `database` is
    /// ignored — attached databases are addressed by qualified name instead.
    async fn open_session(&self, _database: Option<&str>) -> AppResult<Box<dyn Session>> {
        let conn = open_connection_blocking(self.path.clone()).await?;
        let interrupt = Arc::new(conn.get_interrupt_handle());
        Ok(Box::new(SqliteSession {
            conn: Arc::new(Mutex::new(conn)),
            interrupt,
        }))
    }

    async fn cancel(&self, handle: &CancelHandle) -> AppResult<()> {
        if let CancelHandle::Sqlite(handle) = handle {
            handle.interrupt();
        }
        Ok(())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        with_conn(&self.conn, schema::list_databases).await
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let database = database.to_string();
        with_conn(&self.conn, move |conn| schema::list_tables(conn, &database)).await
    }

    async fn list_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let (database, table) = (database.to_string(), table.to_string());
        with_conn(&self.conn, move |conn| schema::list_columns(conn, &database, &table)).await
    }

    async fn list_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        let (database, table) = (database.to_string(), table.to_string());
        with_conn(&self.conn, move |conn| schema::list_indexes(conn, &database, &table)).await
    }

    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        let (database, table) = (database.to_string(), table.to_string());
        with_conn(&self.conn, move |conn| {
            schema::list_foreign_keys(conn, &database, &table)
        })
        .await
    }

    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        let (database, table) = (database.to_string(), table.to_string());
        with_conn(&self.conn, move |conn| schema::table_ddl(conn, &database, &table)).await
    }

    /// Connections close themselves on drop; there is no pool or network
    /// handle to release eagerly.
    async fn close(&self) {}
}

struct SqliteSession {
    conn: Arc<Mutex<Connection>>,
    interrupt: Arc<InterruptHandle>,
}

/// Runs one statement (already split off a multi-statement batch by the
/// execution loop) and reports it as a single-element result: a result set
/// when it has output columns, otherwise an affected-rows count.
fn run_statement(conn: &mut Connection, sql: &str, max_rows: usize) -> AppResult<Vec<StatementResult>> {
    let mut stmt = conn.prepare(sql)?;
    let column_count = stmt.column_count();

    if column_count == 0 {
        let affected = stmt.execute([])? as u64;
        let last_insert_id = if is_insert_statement(sql) {
            let rowid = conn.last_insert_rowid();
            (rowid > 0).then_some(rowid as u64)
        } else {
            None
        };
        return Ok(vec![StatementResult::affected(sql, affected, last_insert_id)]);
    }

    let column_names: Vec<String> = stmt.column_names().into_iter().map(str::to_string).collect();
    // Declared types (`VARCHAR(50)`, `BLOB`) are known for plain table columns;
    // expressions have none and get the storage class of the first non-null value.
    let declared: Vec<Option<String>> = stmt
        .columns()
        .iter()
        .map(|c| c.decl_type().map(|t| t.to_ascii_uppercase()))
        .collect();
    let mut seen_types: Vec<Option<&'static str>> = vec![None; column_count];
    let mut seen_binary: Vec<bool> = declared
        .iter()
        .map(|t| t.as_deref().is_some_and(|t| t.contains("BLOB")))
        .collect();
    let mut rows_out: Vec<Vec<CellValue>> = Vec::new();
    let mut truncated = false;

    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        if rows_out.len() >= max_rows {
            // This row exists but is discarded — it only tells us `truncated`.
            truncated = true;
            break;
        }
        let mut values = Vec::with_capacity(column_count);
        for i in 0..column_count {
            let value_ref = row.get_ref(i)?;
            if seen_types[i].is_none() {
                if let Some((class, binary)) = storage_class(&value_ref) {
                    seen_types[i] = Some(class);
                    seen_binary[i] = binary;
                }
            }
            values.push(value_ref_to_json(value_ref));
        }
        rows_out.push(values);
    }

    let columns = column_names
        .into_iter()
        .zip(declared)
        .zip(seen_types)
        .zip(seen_binary)
        .map(|(((name, declared), seen), binary)| ColumnMeta {
            name,
            table: None,
            database: None,
            type_name: declared.unwrap_or_else(|| seen.unwrap_or("NULL").to_string()),
            unsigned: false,
            nullable: true,
            primary_key: false,
            binary,
        })
        .collect();

    Ok(vec![StatementResult::rows(sql, columns, rows_out, truncated)])
}

fn apply_statements(conn: &mut Connection, statements: &[ParamStatement]) -> AppResult<u64> {
    let tx = conn.transaction()?;
    let mut affected_total = 0u64;

    for stmt in statements {
        let params: Vec<rusqlite::types::Value> = stmt.params.iter().map(json_to_value).collect();
        // A `?` here is enough: dropping `tx` on the way out (instead of committing) rolls it back.
        let affected = tx.execute(&stmt.sql, rusqlite::params_from_iter(params))?;
        affected_total += affected as u64;
    }

    tx.commit()?;
    Ok(affected_total)
}

#[async_trait]
impl Session for SqliteSession {
    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::Sqlite(self.interrupt.clone())
    }

    async fn run(&mut self, sql: &str, max_rows: usize) -> AppResult<Vec<StatementResult>> {
        let sql = sql.to_string();
        with_conn(&self.conn, move |conn| run_statement(conn, &sql, max_rows)).await
    }

    async fn apply(&mut self, statements: &[ParamStatement]) -> AppResult<u64> {
        let statements = statements.to_vec();
        with_conn(&self.conn, move |conn| apply_statements(conn, &statements)).await
    }

    /// Each session owns its connection to a local file; nothing external
    /// can drop it from under us the way a server-side kill would.
    async fn is_alive(&mut self) -> bool {
        true
    }
}
