//! Schema metadata via `system.*` tables, queried with server-side parameters
//! (`param_db` / `param_table`, referenced in SQL as `{db:String}` / `{table:String}`)
//! so identifiers never need to be interpolated into SQL.

use serde_json::Value;

use crate::db::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo, TableKind};
use crate::error::{AppError, AppResult};

use super::format::{parse_compact_rows, parse_type};
use super::ClickhouseDriver;

/// Escapes an identifier for `SHOW CREATE TABLE`, which does not accept
/// server-side parameters, with backticks (doubling any that are already present).
fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn db_table_params(database: &str, table: &str) -> Vec<(&'static str, String)> {
    vec![("param_db", database.to_string()), ("param_table", table.to_string())]
}

fn cell_to_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

fn cell_to_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

pub(crate) async fn list_databases(driver: &ClickhouseDriver) -> AppResult<Vec<String>> {
    let body = driver
        .query("SELECT name FROM system.databases ORDER BY name", &[])
        .await?;
    let parsed = parse_compact_rows(&body, usize::MAX)?;
    Ok(parsed.rows.into_iter().filter_map(|row| cell_to_str(&row[0])).collect())
}

pub(crate) async fn list_tables(driver: &ClickhouseDriver, database: &str) -> AppResult<Vec<TableInfo>> {
    let sql = "SELECT name, engine, total_rows, comment FROM system.tables \
               WHERE database = {db:String} ORDER BY name";
    let body = driver.query(sql, &[("param_db", database.to_string())]).await?;
    let parsed = parse_compact_rows(&body, usize::MAX)?;

    Ok(parsed
        .rows
        .into_iter()
        .map(|row| {
            let engine = cell_to_str(&row[1]);
            let kind = match engine.as_deref() {
                Some("View" | "MaterializedView" | "LiveView" | "WindowView") => TableKind::View,
                _ => TableKind::Table,
            };
            TableInfo {
                name: cell_to_str(&row[0]).unwrap_or_default(),
                kind,
                engine,
                rows: cell_to_u64(&row[2]),
                comment: cell_to_str(&row[3]).unwrap_or_default(),
            }
        })
        .collect())
}

pub(crate) async fn list_columns(driver: &ClickhouseDriver, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    let sql = "SELECT name, type, position, is_in_primary_key, default_kind, default_expression, comment \
               FROM system.columns WHERE database = {db:String} AND table = {table:String} ORDER BY position";
    let body = driver.query(sql, &db_table_params(database, table)).await?;
    let parsed = parse_compact_rows(&body, usize::MAX)?;

    Ok(parsed
        .rows
        .into_iter()
        .map(|row| {
            let raw_type = cell_to_str(&row[1]).unwrap_or_default();
            let parsed_type = parse_type(&raw_type);
            // Strip trailing type parameters, e.g. "Decimal(10, 2)" -> "Decimal".
            let data_type = match parsed_type.name.find('(') {
                Some(idx) => parsed_type.name[..idx].to_string(),
                None => parsed_type.name,
            };
            let default_expression = cell_to_str(&row[5]).unwrap_or_default();
            let default_kind = cell_to_str(&row[4]).unwrap_or_default();
            let is_in_primary_key = cell_to_u64(&row[3]) == Some(1);
            ColumnInfo {
                name: cell_to_str(&row[0]).unwrap_or_default(),
                data_type,
                column_type: raw_type,
                nullable: parsed_type.nullable,
                key: if is_in_primary_key {
                    "PRI".to_string()
                } else {
                    String::new()
                },
                default_value: (!default_expression.is_empty()).then_some(default_expression),
                extra: default_kind,
                comment: cell_to_str(&row[6]).unwrap_or_default(),
                ordinal: cell_to_u64(&row[2]).unwrap_or_default() as u32,
            }
        })
        .collect())
}

pub(crate) async fn list_indexes(driver: &ClickhouseDriver, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    let mut result = Vec::new();

    let pk_sql = "SELECT primary_key FROM system.tables WHERE database = {db:String} AND name = {table:String}";
    let body = driver.query(pk_sql, &db_table_params(database, table)).await?;
    let parsed = parse_compact_rows(&body, 1)?;
    let primary_key = parsed
        .rows
        .first()
        .and_then(|row| cell_to_str(&row[0]))
        .unwrap_or_default();
    if !primary_key.is_empty() {
        result.push(IndexInfo {
            name: "PRIMARY".to_string(),
            unique: false,
            columns: primary_key.split(", ").map(str::to_string).collect(),
            index_type: "primary".to_string(),
        });
    }

    let idx_sql = "SELECT name, type, expr FROM system.data_skipping_indices \
                   WHERE database = {db:String} AND table = {table:String} ORDER BY name";
    let body = driver.query(idx_sql, &db_table_params(database, table)).await?;
    let parsed = parse_compact_rows(&body, usize::MAX)?;
    for row in parsed.rows {
        result.push(IndexInfo {
            name: cell_to_str(&row[0]).unwrap_or_default(),
            unique: false,
            columns: vec![cell_to_str(&row[2]).unwrap_or_default()],
            index_type: cell_to_str(&row[1]).unwrap_or_default(),
        });
    }

    Ok(result)
}

/// ClickHouse has no notion of foreign keys.
pub(crate) async fn list_foreign_keys(
    _driver: &ClickhouseDriver,
    _database: &str,
    _table: &str,
) -> AppResult<Vec<ForeignKeyInfo>> {
    Ok(Vec::new())
}

pub(crate) async fn table_ddl(driver: &ClickhouseDriver, database: &str, table: &str) -> AppResult<String> {
    let sql = format!("SHOW CREATE TABLE {}.{}", quote_ident(database), quote_ident(table));
    let body = driver.query(&sql, &[]).await?;
    let parsed = parse_compact_rows(&body, 1)?;
    parsed
        .rows
        .into_iter()
        .next()
        .and_then(|row| row.into_iter().next())
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or_else(|| AppError::Database("SHOW CREATE TABLE returned an empty result".into()))
}

#[cfg(test)]
mod tests {
    use super::quote_ident;

    #[test]
    fn quote_ident_wraps_in_backticks() {
        assert_eq!(quote_ident("shop"), "`shop`");
    }

    #[test]
    fn quote_ident_doubles_existing_backticks() {
        assert_eq!(quote_ident("a`b"), "`a``b`");
    }
}
