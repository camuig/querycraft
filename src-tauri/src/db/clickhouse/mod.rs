//! ClickHouse backend over the HTTP interface (`reqwest`): a shared client
//! for driver-level queries, a `session_id` per session so `USE`/`SET`
//! persist across statements, and best-effort cancellation via `KILL QUERY`.

pub(crate) mod format;
mod schema;
mod transport;

use async_trait::async_trait;
use reqwest::Client;
use uuid::Uuid;

use crate::connections::StoredConnectionView;
use crate::error::{AppError, AppResult};

use super::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo};
use super::{
    read_ca_certificate, CancelHandle, DbKind, Driver, Endpoint, ParamStatement, ServerInfo, Session, StatementResult,
};
use transport::request;

/// How long to wait for the TCP/TLS connection to be established. Bounds a
/// connection attempt to an unreachable or wrong host/port, which would
/// otherwise leave the UI stuck on "connecting" with no error.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// How long a metadata request (server version, schema) may take in total.
/// Console statements are not bounded by this (see `transport::request`).
const METADATA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub struct ClickhouseDriver {
    client: Client,
    base_url: String,
    user: String,
    password: String,
    /// What a session opened without an explicit database falls back to.
    database: Option<String>,
}

impl ClickhouseDriver {
    /// The URL keeps the configured host name so TLS verifies the right certificate;
    /// through a tunnel that name is resolved to the tunnel's local end instead of DNS.
    pub async fn connect(
        config: &StoredConnectionView,
        endpoint: &Endpoint,
        password: Option<String>,
    ) -> AppResult<Self> {
        let mut builder = Client::builder().connect_timeout(CONNECT_TIMEOUT);
        if config.ssl {
            if let Some(pem) = read_ca_certificate(config)? {
                let certificate = reqwest::Certificate::from_pem(&pem)
                    .map_err(|e| AppError::Other(format!("The CA certificate file is not a PEM certificate: {e}")))?;
                builder = builder.add_root_certificate(certificate);
            }
            if !config.ssl_verify {
                builder = builder.tls_danger_accept_invalid_certs(true);
            }
        }
        if endpoint.tunneled {
            let addr: std::net::SocketAddr = format!("{}:{}", endpoint.host, endpoint.port)
                .parse()
                .map_err(|e| AppError::Other(format!("invalid tunnel address {}: {e}", endpoint.host)))?;
            builder = builder.resolve(&config.host, addr);
        }
        let client = builder.build()?;
        let scheme = if config.ssl { "https" } else { "http" };

        Ok(Self {
            client,
            base_url: format!("{scheme}://{}:{}/", config.host, endpoint.port),
            user: config.user.clone(),
            password: password.unwrap_or_default(),
            database: config.database.clone(),
        })
    }

    /// A plain request without session or row-limiting parameters, for
    /// driver-level queries (server info, schema, `KILL QUERY`).
    async fn query(&self, sql: &str, params: &[(&str, String)]) -> AppResult<String> {
        Ok(request(
            &self.client,
            &self.base_url,
            &self.user,
            &self.password,
            sql,
            params,
            Some(METADATA_TIMEOUT),
        )
        .await?
        .body)
    }
}

#[async_trait]
impl Driver for ClickhouseDriver {
    fn kind(&self) -> DbKind {
        DbKind::Clickhouse
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let body = self.query("SELECT version()", &[]).await?;
        let parsed = format::parse_compact_rows(&body, 1)?;
        let server_version = parsed
            .rows
            .into_iter()
            .next()
            .and_then(|row| row.into_iter().next())
            .and_then(|v| v.as_str().map(str::to_string))
            .ok_or_else(|| AppError::Database("Empty response from the server on connect".into()))?;
        Ok(ServerInfo {
            server_version,
            connection_id: None,
        })
    }

    async fn open_session(&self, database: Option<&str>) -> AppResult<Box<dyn Session>> {
        let database = database.map(str::to_string).or_else(|| self.database.clone());
        Ok(Box::new(ClickhouseSession {
            client: self.client.clone(),
            base_url: self.base_url.clone(),
            user: self.user.clone(),
            password: self.password.clone(),
            session_id: Uuid::new_v4().to_string(),
            database,
            next_query_id: Uuid::new_v4().to_string(),
        }))
    }

    async fn cancel(&self, handle: &CancelHandle) -> AppResult<()> {
        let CancelHandle::ClickhouseQuery(query_id) = handle else {
            return Ok(());
        };
        let sql = format!("KILL QUERY WHERE query_id = {} ASYNC", quote_literal(query_id));
        self.query(&sql, &[]).await?;
        Ok(())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        schema::list_databases(self).await
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        schema::list_tables(self, database).await
    }

    async fn list_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        schema::list_columns(self, database, table).await
    }

    async fn list_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        schema::list_indexes(self, database, table).await
    }

    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        schema::list_foreign_keys(self, database, table).await
    }

    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        schema::table_ddl(self, database, table).await
    }

    async fn close(&self) {
        // Plain HTTP requests over a shared client own no persistent connection to release.
    }
}

/// Quotes a string literal for a ClickHouse SQL statement (backslash and
/// single-quote escaping), used to embed the cancelled statement's query id.
fn quote_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

struct ClickhouseSession {
    client: Client,
    base_url: String,
    user: String,
    password: String,
    /// Stable for the session's lifetime so `USE`/`SET` persist across statements.
    session_id: String,
    database: Option<String>,
    /// The id the next statement will run with. `cancel_handle` hands this
    /// out before the statement starts; `run` rotates it once the request finishes.
    next_query_id: String,
}

impl ClickhouseSession {
    fn params(&self, query_id: &str, max_rows: usize) -> Vec<(&'static str, String)> {
        let mut params = vec![
            ("session_id", self.session_id.clone()),
            ("query_id", query_id.to_string()),
            ("max_result_rows", (max_rows as u64 + 1).to_string()),
            ("result_overflow_mode", "break".to_string()),
        ];
        if let Some(database) = &self.database {
            params.push(("database", database.clone()));
        }
        params
    }
}

#[async_trait]
impl Session for ClickhouseSession {
    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::ClickhouseQuery(self.next_query_id.clone())
    }

    async fn run(&mut self, sql: &str, max_rows: usize) -> AppResult<Vec<StatementResult>> {
        let query_id = self.next_query_id.clone();
        let params = self.params(&query_id, max_rows);
        // No response timeout: a console statement may legitimately run for a long time.
        let outcome = request(
            &self.client,
            &self.base_url,
            &self.user,
            &self.password,
            sql,
            &params,
            None,
        )
        .await;
        // A fresh id for the next statement, whether this one succeeded or not.
        self.next_query_id = Uuid::new_v4().to_string();
        let response = outcome?;

        if response.body.trim().is_empty() {
            return Ok(vec![StatementResult::affected(
                sql,
                response.written_rows.unwrap_or(0),
                None,
            )]);
        }

        let parsed = format::parse_compact_rows(&response.body, max_rows)?;
        Ok(vec![StatementResult::rows(
            sql,
            parsed.columns,
            parsed.rows,
            parsed.truncated,
        )])
    }

    async fn apply(&mut self, _statements: &[ParamStatement]) -> AppResult<u64> {
        Err(AppError::Database(
            "Data editing is not supported for ClickHouse".into(),
        ))
    }

    async fn is_alive(&mut self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::quote_literal;

    #[test]
    fn quote_literal_wraps_plain_text() {
        assert_eq!(quote_literal("abc-123"), "'abc-123'");
    }

    #[test]
    fn quote_literal_escapes_quotes_and_backslashes() {
        assert_eq!(quote_literal(r"it's a \test"), r"'it\'s a \\test'");
    }
}
