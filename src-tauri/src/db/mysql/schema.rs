//! Schema metadata via `information_schema` (on a connection from the pool, not a session).

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Row, Value};

use crate::db::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo, TableKind};
use crate::error::{AppError, AppResult};

use super::quote_ident;

pub async fn list_databases(conn: &mut Conn) -> AppResult<Vec<String>> {
    let mut databases: Vec<String> = conn.query("SHOW DATABASES").await?;
    databases.sort();
    Ok(databases)
}

/// (TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT)
type TableRow = (String, String, Option<String>, Option<u64>, String);
/// (COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION)
type ColumnRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    u32,
);

pub async fn list_tables(conn: &mut Conn, database: &str) -> AppResult<Vec<TableInfo>> {
    let rows: Vec<TableRow> = conn
        .exec(
            "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            (database.to_string(),),
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(|(name, table_type, engine, rows, comment)| {
            let kind = if table_type.to_ascii_uppercase().contains("VIEW") {
                TableKind::View
            } else {
                TableKind::Table
            };
            TableInfo {
                name,
                kind,
                engine,
                rows,
                comment,
            }
        })
        .collect())
}

pub async fn list_columns(conn: &mut Conn, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    let rows: Vec<ColumnRow> = conn
        .exec(
            "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            (database.to_string(), table.to_string()),
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(
            |(name, data_type, column_type, is_nullable, key, default_value, extra, comment, ordinal)| ColumnInfo {
                name,
                data_type,
                column_type,
                nullable: is_nullable.eq_ignore_ascii_case("YES"),
                key,
                default_value,
                extra,
                comment,
                ordinal,
            },
        )
        .collect())
}

pub async fn list_indexes(conn: &mut Conn, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    let rows: Vec<(String, i64, String, String)> = conn
        .exec(
            "SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME \
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
            (database.to_string(), table.to_string()),
        )
        .await?;

    let mut result: Vec<IndexInfo> = Vec::new();
    for (index_name, non_unique, index_type, column_name) in rows {
        if let Some(last) = result.last_mut() {
            if last.name == index_name {
                last.columns.push(column_name);
                continue;
            }
        }
        result.push(IndexInfo {
            name: index_name,
            unique: non_unique == 0,
            columns: vec![column_name],
            index_type,
        });
    }
    Ok(result)
}

pub async fn list_foreign_keys(conn: &mut Conn, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
    let rows: Vec<(String, String, String, String, String, String, String)> = conn
        .exec(
            "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_SCHEMA, \
                    kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE kcu \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
               ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
              AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
              AND rc.TABLE_NAME = kcu.TABLE_NAME \
             WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
            (database.to_string(), table.to_string()),
        )
        .await?;

    let mut result: Vec<ForeignKeyInfo> = Vec::new();
    for (name, column, ref_database, ref_table, ref_column, on_update, on_delete) in rows {
        if let Some(last) = result.last_mut() {
            if last.name == name {
                last.columns.push(column);
                last.ref_columns.push(ref_column);
                continue;
            }
        }
        result.push(ForeignKeyInfo {
            name,
            columns: vec![column],
            ref_database,
            ref_table,
            ref_columns: vec![ref_column],
            on_update,
            on_delete,
        });
    }
    Ok(result)
}

/// `SHOW CREATE TABLE` also works for views (MySQL returns
/// `CREATE VIEW ...`), so we try it first and fall back to
/// `SHOW CREATE VIEW` only if the TABLE variant returned an error.
pub async fn get_table_ddl(conn: &mut Conn, database: &str, table: &str) -> AppResult<String> {
    let qualified = format!("{}.{}", quote_ident(database), quote_ident(table));

    match show_create_ddl(conn, &format!("SHOW CREATE TABLE {qualified}")).await {
        Ok(ddl) => Ok(ddl),
        Err(_) => show_create_ddl(conn, &format!("SHOW CREATE VIEW {qualified}")).await,
    }
}

/// `SHOW CREATE TABLE`/`SHOW CREATE VIEW` — the DDL is always in the second column (index 1).
async fn show_create_ddl(conn: &mut Conn, sql: &str) -> AppResult<String> {
    let row: Option<Row> = conn.query_first(sql).await?;
    let row = row.ok_or_else(|| AppError::Database("SHOW CREATE returned an empty result".into()))?;
    let value = row
        .as_ref(1)
        .cloned()
        .ok_or_else(|| AppError::Database("SHOW CREATE response has no DDL column".into()))?;
    match value {
        Value::Bytes(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        other => Err(AppError::Database(format!("Unexpected DDL value type: {other:?}"))),
    }
}
