//! Engine-independent execution loop: splitting into statements, running them
//! one by one on the tab's session, recording history, exporting a complete
//! result to a file, and applying parameterized changes in a single transaction.

use std::time::Instant;

use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::history::History;
use crate::sql_split::split_statements;

use super::export::{self, ExportFormat, ExportSummary};
use super::{ApplyResult, CellValue, ConnectionManager, DbKind, ParamStatement, StatementResult, StatementResultKind};

const DEFAULT_MAX_ROWS: usize = 500;
/// Row limit for exports: effectively unlimited, yet finite so that engines
/// which pass it on as a setting (ClickHouse `max_result_rows`) accept it.
const EXPORT_MAX_ROWS: usize = u32::MAX as usize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    pub connection_id: String,
    pub session_id: String,
    pub query_id: String,
    pub sql: String,
    pub max_rows: u32,
    pub database: Option<String>,
    pub stop_on_error: bool,
}

/// RAII helper: removes the running-query record when leaving scope
/// (success, error, or an early `break`).
struct RunningQueryGuard<'a> {
    manager: &'a ConnectionManager,
    query_id: &'a str,
}

impl Drop for RunningQueryGuard<'_> {
    fn drop(&mut self) {
        self.manager.unregister_query(self.query_id);
    }
}

pub async fn execute(
    manager: &ConnectionManager,
    history: &History,
    request: ExecuteRequest,
) -> AppResult<Vec<StatementResult>> {
    let kind = manager.driver(&request.connection_id)?.kind();
    let session = manager
        .get_session(&request.connection_id, &request.session_id, request.database.as_deref())
        .await?;

    let statements = split_statements(&request.sql, kind == DbKind::Postgres);
    let max_rows = if request.max_rows == 0 {
        DEFAULT_MAX_ROWS
    } else {
        request.max_rows as usize
    };

    let mut results = Vec::with_capacity(statements.len());

    for stmt in statements {
        let mut session = session.lock().await;
        manager.register_query(&request.query_id, &request.connection_id, session.cancel_handle());
        let _guard = RunningQueryGuard {
            manager,
            query_id: &request.query_id,
        };

        let start = Instant::now();
        let outcome = session.run(&stmt.sql, max_rows).await;
        let duration_ms = start.elapsed().as_millis() as u64;
        drop(session);

        match outcome {
            Ok(mut per_set_results) => {
                for r in &mut per_set_results {
                    r.duration_ms = duration_ms;
                }
                history.record(
                    &request.connection_id,
                    request.database.as_deref(),
                    &stmt.sql,
                    duration_ms,
                    true,
                )?;
                results.extend(per_set_results);
            }
            Err(e) => {
                history.record(
                    &request.connection_id,
                    request.database.as_deref(),
                    &stmt.sql,
                    duration_ms,
                    false,
                )?;
                results.push(StatementResult::error(&stmt.sql, e.to_string(), duration_ms));

                if request.stop_on_error {
                    break;
                }
            }
        }
    }

    Ok(results)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub connection_id: String,
    pub session_id: String,
    pub query_id: String,
    /// A single statement (the `sql` of the result being exported).
    pub sql: String,
    pub database: Option<String>,
    pub format: ExportFormat,
    pub path: String,
}

/// Re-runs one statement on the tab's session without the row limit and
/// writes its first result set to `path`. The grid only ever holds the first
/// `max_rows` rows, so an export of a truncated result goes through here.
pub async fn export(manager: &ConnectionManager, request: ExportRequest) -> AppResult<ExportSummary> {
    let session = manager
        .get_session(&request.connection_id, &request.session_id, request.database.as_deref())
        .await?;
    let result = run_registered(
        manager,
        &session,
        &request.query_id,
        &request.connection_id,
        &request.sql,
        EXPORT_MAX_ROWS,
    )
    .await?
    .into_iter()
    .find(|r| r.kind == StatementResultKind::Rows)
    .ok_or_else(|| AppError::Other("The statement returned no rows to export".into()))?;
    export::write_file(&request.path, request.format, &result.columns, &result.rows)?;
    Ok(ExportSummary {
        rows: result.rows.len(),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountRequest {
    pub connection_id: String,
    pub session_id: String,
    pub query_id: String,
    /// A single statement (the `sql` of the result being counted).
    pub sql: String,
    pub database: Option<String>,
}

/// Wraps a statement so that the engine counts its rows instead of returning them.
pub fn count_sql(sql: &str) -> String {
    let inner = sql.trim().trim_end_matches(';').trim_end();
    format!("SELECT COUNT(*) FROM ({inner}) AS querycraft_count")
}

/// Counts the rows a statement produces, as DataGrip does when the row count
/// in the footer is clicked. Runs on the tab's session and is not recorded in
/// the history.
pub async fn count(manager: &ConnectionManager, request: CountRequest) -> AppResult<u64> {
    let session = manager
        .get_session(&request.connection_id, &request.session_id, request.database.as_deref())
        .await?;
    let sql = count_sql(&request.sql);
    let results = run_registered(manager, &session, &request.query_id, &request.connection_id, &sql, 1).await?;
    results
        .iter()
        .find(|r| r.kind == StatementResultKind::Rows)
        .and_then(|r| r.rows.first())
        .and_then(|row| row.first())
        .and_then(cell_as_count)
        .ok_or_else(|| AppError::Other("COUNT(*) returned no value".into()))
}

/// Engines return the count as an integer, a float or (ClickHouse UInt64) a string.
fn cell_as_count(v: &CellValue) -> Option<u64> {
    match v {
        CellValue::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)),
        CellValue::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// Runs one statement on the session while it is registered as a running
/// query, so that it can be cancelled like anything started from the console.
async fn run_registered(
    manager: &ConnectionManager,
    session: &super::manager::SharedSession,
    query_id: &str,
    connection_id: &str,
    sql: &str,
    max_rows: usize,
) -> AppResult<Vec<StatementResult>> {
    let mut session = session.lock().await;
    manager.register_query(query_id, connection_id, session.cancel_handle());
    let _guard = RunningQueryGuard { manager, query_id };
    session.run(sql, max_rows).await
}

/// Executes parameterized statements in a single transaction (data editing).
/// Rolls back the transaction and returns an error on the first failure.
pub async fn apply_changes(
    manager: &ConnectionManager,
    connection_id: &str,
    session_id: &str,
    statements: Vec<ParamStatement>,
) -> AppResult<ApplyResult> {
    let session = manager.get_session(connection_id, session_id, None).await?;
    let mut session = session.lock().await;

    let start = Instant::now();
    let affected_rows = session.apply(&statements).await?;

    Ok(ApplyResult {
        affected_rows,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn count_sql_wraps_the_statement_without_its_terminator() {
        assert_eq!(
            count_sql("SELECT * FROM t WHERE a > 1 ORDER BY a;\n"),
            "SELECT COUNT(*) FROM (SELECT * FROM t WHERE a > 1 ORDER BY a) AS querycraft_count"
        );
        assert_eq!(
            count_sql("select 1"),
            "SELECT COUNT(*) FROM (select 1) AS querycraft_count"
        );
    }

    #[test]
    fn count_cells_come_as_integers_floats_or_strings() {
        assert_eq!(cell_as_count(&json!(42)), Some(42));
        assert_eq!(cell_as_count(&json!(42.0)), Some(42));
        assert_eq!(cell_as_count(&json!("18446744073709551615")), Some(u64::MAX));
        assert_eq!(cell_as_count(&json!("many")), None);
        assert_eq!(cell_as_count(&CellValue::Null), None);
    }
}
