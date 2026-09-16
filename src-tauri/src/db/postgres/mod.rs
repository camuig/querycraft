//! PostgreSQL backend on `tokio-postgres`: one metadata `Client` per
//! connection, a dedicated `Client` per session, and the cancel-request
//! protocol (`CancelToken`) for cancellation.
//!
//! Results are always read through the simple query protocol
//! (`Client::simple_query`), which returns every value as text regardless of
//! its wire type — that's what lets a single code path handle arbitrary
//! result shapes without per-type binary decoders. A best-effort
//! `Client::prepare` beforehand recovers the real column types so text can be
//! converted into the right JSON shape (see `convert::text_to_cell`). One
//! limitation this implies: `simple_query` buffers the whole result before
//! `run` can start counting rows, so `max_rows` limits what is *returned*,
//! not what is *fetched* from the server.
//!
//! "database" in the `Driver`/`Session` API means *schema* here: a
//! PostgreSQL connection is bound to one database for its lifetime, and the
//! explorer shows that database's schemas as the top-level namespaces.

pub mod convert;
pub mod schema;

use async_trait::async_trait;
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::types::{ToSql, Type};
use tokio_postgres::{Client, Config, Connection, NoTls, SimpleQueryMessage, Socket};

use crate::connections::StoredConnectionView;
use crate::error::{AppError, AppResult};

use super::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo};
use super::{
    CancelHandle, CellValue, ColumnMeta, DbKind, Driver, ParamStatement, ServerInfo, Session, StatementResult,
};
use convert::{column_meta, json_to_text_param, parse_server_version, quote_ident, text_to_cell};

/// Which TLS mode a connection was opened with — kept around because both
/// opening new connections (sessions) and cancelling a running statement
/// need to reconnect with the same settings.
#[derive(Clone)]
enum TlsChoice {
    Disabled(NoTls),
    Enabled(MakeTlsConnector),
}

fn build_config(config: &StoredConnectionView, password: Option<String>) -> Config {
    let mut pg_config = Config::new();
    pg_config.host(config.host.clone()).port(config.port).user(&config.user);
    if let Some(password) = password {
        pg_config.password(password);
    }
    let dbname = config
        .database
        .as_deref()
        .filter(|d| !d.is_empty())
        .unwrap_or("postgres");
    pg_config.dbname(dbname);
    if config.ssl {
        pg_config.ssl_mode(tokio_postgres::config::SslMode::Require);
    }
    pg_config
}

/// TLS options: the server certificate and host name are verified against
/// the system trust store by default; verification is skipped only when the
/// user opted out (self-signed certificates on a trusted network).
fn tls_choice(config: &StoredConnectionView) -> AppResult<TlsChoice> {
    if !config.ssl {
        return Ok(TlsChoice::Disabled(NoTls));
    }
    let connector = TlsConnector::builder()
        .danger_accept_invalid_certs(!config.ssl_verify)
        .danger_accept_invalid_hostnames(!config.ssl_verify)
        .build()
        .map_err(|e| AppError::Database(format!("TLS configuration error: {e}")))?;
    Ok(TlsChoice::Enabled(MakeTlsConnector::new(connector)))
}

/// Spawns the connection's background I/O future, without which no request
/// made through its `Client` ever completes.
fn spawn_connection<T>(connection: Connection<Socket, T>)
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            log::warn!("postgres connection error: {e}");
        }
    });
}

async fn connect_client(pg_config: &Config, tls: &TlsChoice) -> AppResult<Client> {
    match tls {
        TlsChoice::Disabled(no_tls) => {
            let (client, connection) = pg_config.connect(*no_tls).await?;
            spawn_connection(connection);
            Ok(client)
        }
        TlsChoice::Enabled(connector) => {
            let (client, connection) = pg_config.connect(connector.clone()).await?;
            spawn_connection(connection);
            Ok(client)
        }
    }
}

pub struct PostgresDriver {
    pg_config: Config,
    tls: TlsChoice,
    /// Connection used for schema introspection; every `open_session` opens its own `Client`.
    metadata: Client,
}

impl PostgresDriver {
    pub async fn connect(config: &StoredConnectionView, password: Option<String>) -> AppResult<Self> {
        let pg_config = build_config(config, password);
        let tls = tls_choice(config)?;
        let metadata = connect_client(&pg_config, &tls).await?;
        Ok(Self {
            pg_config,
            tls,
            metadata,
        })
    }
}

#[async_trait]
impl Driver for PostgresDriver {
    fn kind(&self) -> DbKind {
        DbKind::Postgres
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let full_version: String = self.metadata.query_one_scalar("SHOW server_version", &[]).await?;
        let pid: i32 = self.metadata.query_one_scalar("SELECT pg_backend_pid()", &[]).await?;
        Ok(ServerInfo {
            server_version: parse_server_version(&full_version),
            connection_id: Some(pid as u64),
        })
    }

    async fn open_session(&self, database: Option<&str>) -> AppResult<Box<dyn Session>> {
        let client = connect_client(&self.pg_config, &self.tls).await?;
        if let Some(schema) = database {
            client
                .batch_execute(&format!("SET search_path TO {}", quote_ident(schema)))
                .await?;
        }
        Ok(Box::new(PostgresSession { client }))
    }

    async fn cancel(&self, handle: &CancelHandle) -> AppResult<()> {
        let CancelHandle::Postgres(token) = handle else {
            return Ok(());
        };
        match &self.tls {
            TlsChoice::Disabled(no_tls) => token.cancel_query(*no_tls).await?,
            TlsChoice::Enabled(connector) => token.cancel_query(connector.clone()).await?,
        }
        Ok(())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        schema::list_databases(&self.metadata).await
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        schema::list_tables(&self.metadata, database).await
    }

    async fn list_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        schema::list_columns(&self.metadata, database, table).await
    }

    async fn list_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        schema::list_indexes(&self.metadata, database, table).await
    }

    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        schema::list_foreign_keys(&self.metadata, database, table).await
    }

    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        schema::table_ddl(&self.metadata, database, table).await
    }

    async fn close(&self) {
        // The metadata connection closes when the driver (and its `Client`) is
        // dropped; there is nothing to flush beforehand.
    }
}

struct PostgresSession {
    client: Client,
}

/// Reads every message of a simple-query response into one `StatementResult`
/// per result set. `prepared_types`, from a best-effort `prepare`, lets cells
/// be converted by their real column type; a column beyond its length (or
/// when `prepare` failed entirely) falls back to `Type::UNKNOWN`, which is
/// rendered as plain text.
fn collect_result_sets(
    messages: Vec<SimpleQueryMessage>,
    sql: &str,
    max_rows: usize,
    prepared_types: &[Type],
) -> Vec<StatementResult> {
    let mut results = Vec::new();
    let mut columns: Option<Vec<ColumnMeta>> = None;
    let mut rows: Vec<Vec<CellValue>> = Vec::new();
    let mut truncated = false;

    for message in messages {
        match message {
            SimpleQueryMessage::RowDescription(cols) => {
                columns = Some(
                    cols.iter()
                        .enumerate()
                        .map(|(i, c)| column_meta(c.name(), prepared_types.get(i).unwrap_or(&Type::UNKNOWN)))
                        .collect(),
                );
                rows = Vec::new();
                truncated = false;
            }
            SimpleQueryMessage::Row(row) => {
                // A row always follows a RowDescription in the same result set;
                // `columns` is `None` only before the first set is seen.
                if columns.is_some() {
                    if rows.len() < max_rows {
                        let values = (0..row.len())
                            .map(|i| text_to_cell(row.get(i), prepared_types.get(i).unwrap_or(&Type::UNKNOWN)))
                            .collect();
                        rows.push(values);
                    } else {
                        truncated = true;
                    }
                }
            }
            SimpleQueryMessage::CommandComplete(n) => {
                if let Some(cols) = columns.take() {
                    results.push(StatementResult::rows(sql, cols, std::mem::take(&mut rows), truncated));
                } else {
                    results.push(StatementResult::affected(sql, n, None));
                }
                truncated = false;
            }
            _ => {} // SimpleQueryMessage is #[non_exhaustive]; nothing else to act on today.
        }
    }

    results
}

#[async_trait]
impl Session for PostgresSession {
    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::Postgres(self.client.cancel_token())
    }

    async fn run(&mut self, sql: &str, max_rows: usize) -> AppResult<Vec<StatementResult>> {
        // Best-effort: a query that can't be prepared (e.g. some DDL, or
        // several statements in one string) still runs — just without typed columns.
        let prepared_types: Vec<Type> = match self.client.prepare(sql).await {
            Ok(stmt) => stmt.columns().iter().map(|c| c.type_().clone()).collect(),
            Err(_) => Vec::new(),
        };

        let messages = self.client.simple_query(sql).await?;
        Ok(collect_result_sets(messages, sql, max_rows, &prepared_types))
    }

    async fn apply(&mut self, statements: &[ParamStatement]) -> AppResult<u64> {
        let tx = self.client.transaction().await?;
        let mut affected_total = 0u64;

        for stmt in statements {
            let rewritten = convert::rewrite_placeholders(&stmt.sql);
            let params: Vec<_> = stmt.params.iter().map(json_to_text_param).collect();
            let param_refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();

            match tx.execute(rewritten.as_str(), &param_refs).await {
                Ok(n) => affected_total += n,
                // Dropping `tx` here rolls the transaction back.
                Err(e) => return Err(e.into()),
            }
        }

        tx.commit().await?;
        Ok(affected_total)
    }

    async fn is_alive(&mut self) -> bool {
        !self.client.is_closed()
    }
}
