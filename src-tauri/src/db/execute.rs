//! Engine-independent execution loop: splitting into statements, running them
//! one by one on the tab's session, recording history, and applying
//! parameterized changes in a single transaction.

use std::time::Instant;

use serde::Deserialize;

use crate::error::AppResult;
use crate::history::History;
use crate::sql_split::split_statements;

use super::{ApplyResult, ConnectionManager, DbKind, ParamStatement, StatementResult};

const DEFAULT_MAX_ROWS: usize = 500;

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
