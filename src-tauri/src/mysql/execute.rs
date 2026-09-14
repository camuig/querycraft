//! Выполнение SQL: разбиение на выражения, потоковое чтение результатов до
//! `maxRows`, и применение параметризованных изменений в одной транзакции.

use std::time::Instant;

use mysql_async::prelude::Queryable;
use mysql_async::{QueryResult, TextProtocol, TxOpts, Value};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::history::History;
use crate::sql_split::split_statements;

use super::convert::{column_meta, json_to_value, value_to_json, CellValue, ColumnMeta};
use super::ConnectionManager;

const DEFAULT_MAX_ROWS: usize = 500;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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

/// RAII-хелпер: снимает запись о выполняющемся запросе при выходе из области
/// видимости (успех, ошибка или ранний `break`).
struct RunningQueryGuard<'a> {
    manager: &'a ConnectionManager,
    query_id: &'a str,
}

impl Drop for RunningQueryGuard<'_> {
    fn drop(&mut self) {
        self.manager.unregister_query(self.query_id);
    }
}

/// Читает все наборы результатов текущего `QueryResult`, по одному
/// `StatementResult` на набор (для `CALL proc()`, возвращающего несколько).
/// Ошибка чтения (например, обрыв соединения на втором наборе) возвращается
/// как есть — вызывающий код превращает её в `StatementResult` с kind="error".
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
                    let json_row: Vec<CellValue> =
                        values.iter().zip(columns.iter()).map(|(v, c)| value_to_json(v, c)).collect();
                    rows.push(json_row);
                } else {
                    truncated = true;
                    // Строка уже прочитана и отброшена — цикл продолжит читать
                    // (и отбрасывать) до конца текущего набора.
                }
            }

            per_set_results.push(StatementResult {
                sql: sql.to_string(),
                kind: StatementResultKind::Rows,
                columns: column_metas,
                rows,
                truncated,
                affected_rows: 0,
                last_insert_id: None,
                error: None,
                duration_ms: 0, // проставляется вызывающим кодом
            });
        } else {
            // Набор без колонок (INSERT/UPDATE/DELETE/DDL) — один next()
            // продвигает к следующему набору, если он есть.
            query_result.next().await?;
            per_set_results.push(StatementResult {
                sql: sql.to_string(),
                kind: StatementResultKind::Affected,
                columns: vec![],
                rows: vec![],
                truncated: false,
                affected_rows: query_result.affected_rows(),
                last_insert_id: query_result.last_insert_id(),
                error: None,
                duration_ms: 0,
            });
        }

        if query_result.is_empty() {
            break;
        }
    }

    Ok(per_set_results)
}

pub async fn execute(
    manager: &ConnectionManager,
    history: &History,
    request: ExecuteRequest,
) -> AppResult<Vec<StatementResult>> {
    let session_conn = manager
        .get_session(&request.connection_id, &request.session_id, request.database.as_deref())
        .await?;

    let statements = split_statements(&request.sql);
    let max_rows = if request.max_rows == 0 { DEFAULT_MAX_ROWS } else { request.max_rows as usize };

    let mut results = Vec::with_capacity(statements.len());

    for stmt in statements {
        let mut conn = session_conn.lock().await;
        let thread_id = conn.id();
        manager.register_query(&request.query_id, &request.connection_id, thread_id);
        let _guard = RunningQueryGuard { manager, query_id: &request.query_id };

        let start = Instant::now();
        let outcome: mysql_async::Result<Vec<StatementResult>> = match conn.query_iter(stmt.sql.clone()).await {
            Ok(mut query_result) => collect_result_sets(&mut query_result, &stmt.sql, max_rows).await,
            Err(e) => Err(e),
        };
        let duration_ms = start.elapsed().as_millis() as u64;

        drop(conn);

        match outcome {
            Ok(mut per_set_results) => {
                for r in &mut per_set_results {
                    r.duration_ms = duration_ms;
                }
                history.record(&request.connection_id, request.database.as_deref(), &stmt.sql, duration_ms, true)?;
                results.extend(per_set_results);
            }
            Err(e) => {
                let app_err = AppError::from(e);
                history.record(&request.connection_id, request.database.as_deref(), &stmt.sql, duration_ms, false)?;
                results.push(StatementResult {
                    sql: stmt.sql.clone(),
                    kind: StatementResultKind::Error,
                    columns: vec![],
                    rows: vec![],
                    truncated: false,
                    affected_rows: 0,
                    last_insert_id: None,
                    error: Some(app_err.to_string()),
                    duration_ms,
                });

                if request.stop_on_error {
                    break;
                }
            }
        }
    }

    Ok(results)
}

/// Выполняет параметризованные выражения в одной транзакции (редактирование данных).
/// Откатывает транзакцию и возвращает ошибку при первом же сбое.
pub async fn apply_changes(
    manager: &ConnectionManager,
    connection_id: &str,
    session_id: &str,
    statements: Vec<ParamStatement>,
) -> AppResult<ApplyResult> {
    let session_conn = manager.get_session(connection_id, session_id, None).await?;
    let mut conn = session_conn.lock().await;

    let start = Instant::now();
    let mut tx = conn.start_transaction(TxOpts::default()).await?;
    let mut affected_total = 0u64;

    for stmt in statements {
        let params: Vec<Value> = stmt.params.iter().map(json_to_value).collect();
        if let Err(e) = tx.exec_drop(stmt.sql, params).await {
            let _ = tx.rollback().await;
            return Err(e.into());
        }
        affected_total += tx.affected_rows();
    }

    tx.commit().await?;

    Ok(ApplyResult {
        affected_rows: affected_total,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}
