//! Microsoft SQL Server backend on `tiberius`: one metadata `Client` per
//! connection (guarded by a `tokio::sync::Mutex`, since tiberius needs
//! `&mut self` per query), a dedicated `Client` per session, and `KILL
//! <spid>` on a utility connection for cancellation.
//!
//! TLS: this backend uses tiberius's `rustls` feature, unlike every other
//! backend in the app (`mysql_async`, `tokio-postgres`, `reqwest`, `redis`),
//! which all use `native-tls`. SQL Server always TLS-wraps the login packet
//! (see `build_config` below), and on macOS `native-tls` (the system
//! Security.framework) cannot complete that handshake at all — every
//! connection attempt fails with `Tls("connection closed via error")`,
//! regardless of `ssl`/`ssl_verify`/CA settings (a known tiberius/macOS
//! incompatibility: <https://github.com/prisma/tiberius/issues/65>). `rustls`
//! has no such issue and is otherwise a drop-in swap — `Config`'s
//! trust/encryption API is identical across tiberius's TLS backends.
//!
//! Results are read through `Client::simple_query`, which streams `Metadata`
//! / `Row` items but — unlike the text-protocol backends — silently drops
//! the tokens that carry a row count for a statement without a result set
//! (`INSERT`/`UPDATE`/`DELETE`/DDL); tiberius only exposes those counts
//! through `Client::execute`, which in turn discards any rows. Since a
//! single `run()` call cannot know ahead of time whether its statement
//! returns rows, every batch has `SELECT @@ROWCOUNT` appended to it; `run`
//! then pairs that trailing result set back to whichever statement had no
//! result set of its own. This works correctly for the common case — `run`
//! is called once per top-level statement by `execute::execute` — but a
//! single statement that itself fans out into several result sets *and* a
//! row-count-only statement (e.g. a stored procedure with a `SELECT` and an
//! `INSERT` in its body) would lose the `INSERT`'s count, since tiberius
//! gives no way to see it interleaved with the `SELECT`s.

pub mod convert;
pub mod schema;

use async_trait::async_trait;
use futures_util::TryStreamExt;
use tiberius::{AuthMethod, Client, Column, Config, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::connections::StoredConnectionView;
use crate::error::{AppError, AppResult};

use super::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo};
use super::{CancelHandle, CellValue, DbKind, Driver, Endpoint, ParamStatement, ServerInfo, Session, StatementResult};

/// The column name of the sentinel `SELECT @@ROWCOUNT` appended to every batch.
const AFFECTED_MARKER: &str = "__querycraft_affected__";

type TdsClient = Client<Compat<TcpStream>>;

/// Builds the tiberius connection configuration.
///
/// TLS: with `ssl` on, encryption is required end-to-end (`Required`); with
/// it off, encryption is limited to the login packet (`Off`) — SQL Server
/// always protects credentials during login regardless of the client's
/// preference, so `Off` is the closer match to the other backends' "no TLS"
/// setting than `NotSupported`, which would refuse a server that mandates
/// even login encryption.
///
/// `ssl_verify` and `ssl_ca_path` are mutually exclusive in tiberius
/// (`trust_cert` vs `trust_cert_ca` panic if both are set); when
/// verification is off, `trust_cert` wins and a configured CA file is
/// ignored, since disabling verification already trusts everything.
fn build_config(config: &StoredConnectionView, endpoint: &Endpoint, password: Option<&str>) -> Config {
    let mut tds_config = Config::new();
    tds_config.host(&config.host);
    tds_config.port(endpoint.port);
    tds_config.authentication(AuthMethod::sql_server(&config.user, password.unwrap_or("")));
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        tds_config.database(db);
    }
    tds_config.encryption(if config.ssl {
        EncryptionLevel::Required
    } else {
        EncryptionLevel::Off
    });
    if !config.ssl_verify {
        tds_config.trust_cert();
    } else if let Some(ca_path) = config.ssl_ca_path.as_deref().filter(|p| !p.is_empty()) {
        tds_config.trust_cert_ca(ca_path);
    }
    tds_config
}

/// Opens a TCP connection to `endpoint` (the tunnel's local end when
/// tunneled) and logs in with `config` (whose `host` stays the *configured*
/// name, so TLS verifies the right certificate even through a tunnel).
async fn connect_client(
    config: &StoredConnectionView,
    endpoint: &Endpoint,
    password: Option<&str>,
) -> AppResult<TdsClient> {
    let tds_config = build_config(config, endpoint, password);
    let tcp = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .await
        .map_err(|e| AppError::Database(format!("cannot reach {}:{}: {e}", endpoint.host, endpoint.port)))?;
    tcp.set_nodelay(true)?;
    let client = Client::connect(tds_config, tcp.compat_write()).await?;
    Ok(client)
}

/// The session's SPID (`sys.dm_exec_sessions.session_id`), used both for
/// `server_info` and as the session's `CancelHandle`.
async fn read_spid(client: &mut TdsClient) -> AppResult<i32> {
    let row = client.simple_query("SELECT @@SPID AS spid").await?.into_row().await?;
    let row = row.ok_or_else(|| AppError::Database("SELECT @@SPID returned no row".into()))?;
    let spid: i16 = row.get(0).unwrap_or(0);
    Ok(spid as i32)
}

pub struct MssqlDriver {
    config: StoredConnectionView,
    endpoint: Endpoint,
    password: Option<String>,
    /// Connection used for schema introspection and `KILL`; every `open_session` opens its own `Client`.
    metadata: Mutex<TdsClient>,
}

impl MssqlDriver {
    pub async fn connect(
        config: &StoredConnectionView,
        endpoint: &Endpoint,
        password: Option<String>,
    ) -> AppResult<Self> {
        let metadata = connect_client(config, endpoint, password.as_deref()).await?;
        Ok(Self {
            config: config.clone(),
            endpoint: endpoint.clone(),
            password,
            metadata: Mutex::new(metadata),
        })
    }
}

#[async_trait]
impl Driver for MssqlDriver {
    fn kind(&self) -> DbKind {
        DbKind::Mssql
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let mut client = self.metadata.lock().await;
        let row = client
            .simple_query(
                "SELECT CONVERT(NVARCHAR(128), SERVERPROPERTY('ProductVersion')), \
                        CONVERT(NVARCHAR(128), SERVERPROPERTY('Edition')), @@SPID",
            )
            .await?
            .into_row()
            .await?;
        let row = row.ok_or_else(|| AppError::Database("Empty response from the server on connect".into()))?;
        let version: &str = row.get(0).unwrap_or("");
        let edition: Option<&str> = row.get(1);
        let spid: i16 = row.get(2).unwrap_or(0);

        let server_version = match edition {
            Some(edition) if !edition.is_empty() => format!("{version} ({edition})"),
            _ => version.to_string(),
        };
        Ok(ServerInfo {
            server_version,
            connection_id: Some(spid as u64),
        })
    }

    async fn open_session(&self, database: Option<&str>) -> AppResult<Box<dyn Session>> {
        let mut client = connect_client(&self.config, &self.endpoint, self.password.as_deref()).await?;
        if let Some(db) = database.filter(|d| !d.is_empty()) {
            client.simple_query(format!("USE {}", convert::quote_ident(db))).await?;
        }
        let spid = read_spid(&mut client).await?;
        Ok(Box::new(MssqlSession { client, spid }))
    }

    async fn cancel(&self, handle: &CancelHandle) -> AppResult<()> {
        let CancelHandle::MssqlSession(spid) = handle else {
            return Ok(());
        };
        // KILL aborts the whole session (heavier than PostgreSQL's cancel
        // request), so the killed session's connection dies and the manager
        // transparently recreates it — the same effect as the MySQL
        // backend's `KILL QUERY`. Errors (most commonly: the session
        // already finished on its own) are logged, not propagated.
        let mut client = self.metadata.lock().await;
        if let Err(e) = client.simple_query(format!("KILL {spid}")).await {
            log::warn!("KILL {spid} failed (the session may have already finished): {e}");
        }
        Ok(())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        let mut client = self.metadata.lock().await;
        schema::list_databases(&mut client).await
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let mut client = self.metadata.lock().await;
        schema::list_tables(&mut client, database).await
    }

    async fn list_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let mut client = self.metadata.lock().await;
        schema::list_columns(&mut client, database, table).await
    }

    async fn list_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        let mut client = self.metadata.lock().await;
        schema::list_indexes(&mut client, database, table).await
    }

    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        let mut client = self.metadata.lock().await;
        schema::list_foreign_keys(&mut client, database, table).await
    }

    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        let mut client = self.metadata.lock().await;
        schema::table_ddl(&mut client, database, table).await
    }

    async fn close(&self) {
        // The connection closes when the client (and its socket) is dropped;
        // tiberius has no explicit async close through `&self`.
    }
}

struct MssqlSession {
    client: TdsClient,
    spid: i32,
}

/// One collected result set: columns seen at its `Metadata` item plus the
/// rows read so far (subject to `max_rows`).
struct Segment {
    columns: Vec<Column>,
    rows: Vec<Vec<CellValue>>,
    truncated: bool,
}

fn cell_as_u64(v: &CellValue) -> Option<u64> {
    match v {
        CellValue::Number(n) => n.as_u64().or_else(|| n.as_i64().map(|n| n.max(0) as u64)),
        _ => None,
    }
}

/// Statements SQL Server requires to be the only one in their batch — the
/// trailing `SELECT @@ROWCOUNT` sentinel would make the batch invalid, so
/// these run alone instead, reported as 0 affected rows (they have no
/// meaningful row count anyway).
fn requires_own_batch(sql: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "CREATE DATABASE",
        "ALTER DATABASE",
        "DROP DATABASE",
        "CREATE SCHEMA",
        "CREATE PROCEDURE",
        "CREATE PROC ",
        "ALTER PROCEDURE",
        "ALTER PROC ",
        "CREATE FUNCTION",
        "ALTER FUNCTION",
        "CREATE VIEW",
        "ALTER VIEW",
        "CREATE TRIGGER",
        "ALTER TRIGGER",
        "USE ",
    ];
    let trimmed = sql.trim_start();
    PREFIXES
        .iter()
        .any(|p| trimmed.len() >= p.len() && trimmed[..p.len()].eq_ignore_ascii_case(p))
}

/// Runs `sql` with a sentinel `SELECT @@ROWCOUNT` appended (see the module
/// doc comment) and turns the resulting segments into `StatementResult`s.
async fn run_stream(client: &mut TdsClient, sql: &str, max_rows: usize) -> AppResult<Vec<StatementResult>> {
    if requires_own_batch(sql) {
        client.simple_query(sql).await?;
        return Ok(vec![StatementResult::affected(sql, 0, None)]);
    }

    // The `\n` before the `;` guards against `sql` ending in a `--` line
    // comment, which would otherwise swallow the separator.
    let batch = format!("{sql}\n;\nSELECT @@ROWCOUNT AS {AFFECTED_MARKER};");
    let mut stream = client.simple_query(batch).await?;

    let mut segments: Vec<Segment> = Vec::new();
    let mut current: Option<Segment> = None;

    while let Some(item) = stream.try_next().await? {
        match item {
            QueryItem::Metadata(meta) => {
                if let Some(seg) = current.take() {
                    segments.push(seg);
                }
                current = Some(Segment {
                    columns: meta.columns().to_vec(),
                    rows: Vec::new(),
                    truncated: false,
                });
            }
            QueryItem::Row(row) => {
                if let Some(seg) = current.as_mut() {
                    if seg.rows.len() < max_rows {
                        let values = row
                            .cells()
                            .map(|(col, data)| convert::cell_to_json(col.column_type(), data))
                            .collect();
                        seg.rows.push(values);
                    } else {
                        seg.truncated = true;
                    }
                }
            }
        }
    }
    if let Some(seg) = current.take() {
        segments.push(seg);
    }

    let affected = match segments.last() {
        Some(seg) if seg.columns.len() == 1 && seg.columns[0].name().eq_ignore_ascii_case(AFFECTED_MARKER) => {
            let seg = segments.pop().expect("checked above");
            seg.rows
                .first()
                .and_then(|r| r.first())
                .and_then(cell_as_u64)
                .unwrap_or(0)
        }
        _ => 0,
    };

    if segments.is_empty() {
        return Ok(vec![StatementResult::affected(sql, affected, None)]);
    }

    Ok(segments
        .into_iter()
        .map(|seg| {
            let columns = seg.columns.iter().map(convert::column_meta).collect();
            StatementResult::rows(sql, columns, seg.rows, seg.truncated)
        })
        .collect())
}

#[async_trait]
impl Session for MssqlSession {
    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::MssqlSession(self.spid)
    }

    async fn run(&mut self, sql: &str, max_rows: usize) -> AppResult<Vec<StatementResult>> {
        run_stream(&mut self.client, sql, max_rows).await
    }

    async fn apply(&mut self, statements: &[ParamStatement]) -> AppResult<u64> {
        self.client.simple_query("BEGIN TRANSACTION").await?;
        let mut affected_total = 0u64;

        for stmt in statements {
            let rewritten = convert::rewrite_placeholders(&stmt.sql);
            let params: Vec<convert::Param> = stmt.params.iter().map(convert::json_to_param).collect();
            let param_refs: Vec<&dyn tiberius::ToSql> = params.iter().map(|p| p as &dyn tiberius::ToSql).collect();

            match self.client.execute(rewritten.as_str(), &param_refs).await {
                Ok(result) => affected_total += result.total(),
                Err(e) => {
                    let _ = self
                        .client
                        .simple_query("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION")
                        .await;
                    return Err(e.into());
                }
            }
        }

        self.client.simple_query("COMMIT TRANSACTION").await?;
        Ok(affected_total)
    }

    async fn is_alive(&mut self) -> bool {
        match self.client.simple_query("SELECT 1").await {
            Ok(stream) => stream.into_row().await.is_ok(),
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::requires_own_batch;

    #[test]
    fn requires_own_batch_matches_batch_only_statements() {
        assert!(requires_own_batch("CREATE DATABASE qc_test"));
        assert!(requires_own_batch("  create schema sales"));
        assert!(requires_own_batch("CREATE PROCEDURE dbo.p AS SELECT 1"));
        assert!(requires_own_batch("CREATE VIEW dbo.v AS SELECT 1"));
        assert!(requires_own_batch("USE qc_test"));
    }

    #[test]
    fn requires_own_batch_leaves_ordinary_statements_alone() {
        assert!(!requires_own_batch("SELECT 1"));
        assert!(!requires_own_batch("CREATE TABLE t (id INT)"));
        assert!(!requires_own_batch("INSERT INTO t VALUES (1)"));
    }
}
