//! MySQL / MariaDB backend on `mysql_async`: a small metadata pool per
//! connection, a dedicated `Conn` per session and `KILL QUERY` for cancellation.

pub mod convert;
pub mod schema;

use std::time::Duration;

use async_trait::async_trait;
use mysql_async::prelude::Queryable;
use mysql_async::{
    Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, QueryResult, SslOpts, TextProtocol, TxOpts, Value,
};

use crate::connections::StoredConnectionView;
use crate::error::{AppError, AppResult};

use super::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo};
use super::{
    CancelHandle, CellValue, ColumnMeta, DbKind, Driver, ParamStatement, ServerInfo, Session, StatementResult,
};
use convert::{column_meta, json_to_value, value_to_json};

/// Escapes an identifier (DB/table name) for use in a DDL query
/// with backticks, doubling any backticks already present.
pub(crate) fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// TLS options: the server certificate is verified against the system trust
/// store by default; verification is skipped only when the user opted out
/// (self-signed certificates on a trusted network).
fn ssl_opts(verify: bool) -> SslOpts {
    let opts = SslOpts::default();
    if verify {
        opts
    } else {
        opts.with_danger_accept_invalid_certs(true)
            .with_danger_skip_domain_validation(true)
    }
}

fn build_opts(config: &StoredConnectionView, password: Option<String>) -> Opts {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(config.host.clone())
        .tcp_port(config.port)
        .user(Some(config.user.clone()))
        .pass(password)
        .db_name(config.database.clone())
        .tcp_keepalive(Some(Duration::from_millis(30_000)));

    if config.ssl {
        builder = builder.ssl_opts(Some(ssl_opts(config.ssl_verify)));
    }

    builder.into()
}

pub struct MysqlDriver {
    kind: DbKind,
    pool: Pool,
    opts: Opts,
}

impl MysqlDriver {
    pub async fn connect(config: &StoredConnectionView, password: Option<String>) -> AppResult<Self> {
        let opts = build_opts(config, password);
        let pool_opts = PoolOpts::default()
            .with_constraints(PoolConstraints::new(1, 4).expect("1 <= 4 and 4 > 0 — valid pool constraints"));
        let pool = Pool::new(OptsBuilder::from_opts(opts.clone()).pool_opts(pool_opts));
        Ok(Self {
            kind: config.kind,
            pool,
            opts,
        })
    }

    /// A connection from the metadata pool (for queries to information_schema, etc.).
    async fn metadata_conn(&self) -> AppResult<Conn> {
        Ok(self.pool.get_conn().await?)
    }
}

#[async_trait]
impl Driver for MysqlDriver {
    fn kind(&self) -> DbKind {
        self.kind
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let mut conn = self.metadata_conn().await?;
        let row: Option<(String, u64)> = conn.query_first("SELECT VERSION(), CONNECTION_ID()").await?;
        let (server_version, connection_id) =
            row.ok_or_else(|| AppError::Database("Empty response from the server on connect".into()))?;
        Ok(ServerInfo {
            server_version,
            connection_id: Some(connection_id),
        })
    }

    async fn open_session(&self, database: Option<&str>) -> AppResult<Box<dyn Session>> {
        let mut conn = Conn::new(self.opts.clone()).await?;
        if let Some(db) = database {
            conn.query_drop(format!("USE {}", quote_ident(db))).await?;
        }
        Ok(Box::new(MysqlSession { conn }))
    }

    async fn cancel(&self, handle: &CancelHandle) -> AppResult<()> {
        let CancelHandle::MysqlThread(thread_id) = handle else {
            return Ok(());
        };
        let mut conn = self.metadata_conn().await?;
        conn.query_drop(format!("KILL QUERY {thread_id}")).await?;
        Ok(())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        schema::list_databases(&mut self.metadata_conn().await?).await
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        schema::list_tables(&mut self.metadata_conn().await?, database).await
    }

    async fn list_columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        schema::list_columns(&mut self.metadata_conn().await?, database, table).await
    }

    async fn list_indexes(&self, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
        schema::list_indexes(&mut self.metadata_conn().await?, database, table).await
    }

    async fn list_foreign_keys(&self, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        schema::list_foreign_keys(&mut self.metadata_conn().await?, database, table).await
    }

    async fn table_ddl(&self, database: &str, table: &str) -> AppResult<String> {
        schema::get_table_ddl(&mut self.metadata_conn().await?, database, table).await
    }

    async fn close(&self) {
        let _ = self.pool.clone().disconnect().await;
    }
}

struct MysqlSession {
    conn: Conn,
}

/// Reads all result sets of the current `QueryResult`, one
/// `StatementResult` per set (for `CALL proc()`, which can return several).
/// A read error (e.g. a dropped connection on the second set) is returned
/// as-is — the caller turns it into a `StatementResult` with kind="error".
async fn collect_result_sets(
    query_result: &mut QueryResult<'_, 'static, TextProtocol>,
    sql: &str,
    max_rows: usize,
) -> mysql_async::Result<Vec<StatementResult>> {
    let mut per_set_results = Vec::new();

    loop {
        let columns = query_result.columns();
        let has_row_columns = columns.as_ref().map(|c| !c.is_empty()).unwrap_or(false);

        if has_row_columns {
            let columns = columns.expect("checked above");
            let column_metas: Vec<ColumnMeta> = columns.iter().map(column_meta).collect();
            let mut rows: Vec<Vec<CellValue>> = Vec::new();
            let mut truncated = false;

            while let Some(row) = query_result.next().await? {
                if rows.len() < max_rows {
                    let values = row.unwrap();
                    let json_row: Vec<CellValue> = values
                        .iter()
                        .zip(columns.iter())
                        .map(|(v, c)| value_to_json(v, c))
                        .collect();
                    rows.push(json_row);
                } else {
                    truncated = true;
                    // The row is already read and discarded — the loop keeps reading
                    // (and discarding) until the end of the current set.
                }
            }

            per_set_results.push(StatementResult::rows(sql, column_metas, rows, truncated));
        } else {
            // A set without columns (INSERT/UPDATE/DELETE/DDL) — a single next()
            // advances to the next set, if there is one.
            query_result.next().await?;
            per_set_results.push(StatementResult::affected(
                sql,
                query_result.affected_rows(),
                query_result.last_insert_id(),
            ));
        }

        if query_result.is_empty() {
            break;
        }
    }

    Ok(per_set_results)
}

#[async_trait]
impl Session for MysqlSession {
    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::MysqlThread(self.conn.id())
    }

    async fn run(&mut self, sql: &str, max_rows: usize) -> AppResult<Vec<StatementResult>> {
        let mut query_result = self.conn.query_iter(sql).await?;
        Ok(collect_result_sets(&mut query_result, sql, max_rows).await?)
    }

    async fn apply(&mut self, statements: &[ParamStatement]) -> AppResult<u64> {
        let mut tx = self.conn.start_transaction(TxOpts::default()).await?;
        let mut affected_total = 0u64;

        for stmt in statements {
            let params: Vec<Value> = stmt.params.iter().map(json_to_value).collect();
            if let Err(e) = tx.exec_drop(&stmt.sql, params).await {
                let _ = tx.rollback().await;
                return Err(e.into());
            }
            affected_total += tx.affected_rows();
        }

        tx.commit().await?;
        Ok(affected_total)
    }

    async fn is_alive(&mut self) -> bool {
        self.conn.ping().await.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::ssl_opts;

    #[test]
    fn ssl_opts_verify_certificates_by_default() {
        let opts = ssl_opts(true);
        assert!(!opts.accept_invalid_certs());
        assert!(!opts.skip_domain_validation());
    }

    #[test]
    fn ssl_opts_can_skip_verification_on_request() {
        let opts = ssl_opts(false);
        assert!(opts.accept_invalid_certs());
        assert!(opts.skip_domain_validation());
    }
}
