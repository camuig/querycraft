//! Schema metadata via SQLite PRAGMAs (`table_info`, `index_list`/`index_info`,
//! `foreign_key_list`, `database_list`) and `sqlite_master`. Runs on the
//! blocking connection handed in by `mod.rs::with_conn`.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::db::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo, TableKind};
use crate::error::{AppError, AppResult};

use super::convert::{extract_data_type, quote_ident};

/// `PRAGMA database_list` — `main`, `temp`, then attached databases, in the
/// order SQLite reports them.
pub fn list_databases(conn: &mut Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA database_list")?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

pub fn list_tables(conn: &mut Connection, database: &str) -> AppResult<Vec<TableInfo>> {
    let sql = format!(
        "SELECT name, type FROM {}.sqlite_master WHERE type IN ('table','view') \
         AND name NOT LIKE 'sqlite_%' ORDER BY name",
        quote_ident(database)
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows
        .into_iter()
        .map(|(name, table_type)| TableInfo {
            name,
            kind: if table_type == "view" {
                TableKind::View
            } else {
                TableKind::Table
            },
            engine: None,
            rows: None,
            comment: String::new(),
        })
        .collect())
}

pub fn list_columns(conn: &mut Connection, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    let sql = format!("PRAGMA {}.table_info({})", quote_ident(database), quote_ident(table));
    let mut stmt = conn.prepare(&sql)?;
    // table_info columns: cid, name, type, notnull, dflt_value, pk
    let mut columns = stmt
        .query_map([], |row| {
            let cid: i64 = row.get(0)?;
            let name: String = row.get(1)?;
            let declared: String = row.get(2)?;
            let notnull: i64 = row.get(3)?;
            let default_value: Option<String> = row.get(4)?;
            let pk: i64 = row.get(5)?;
            Ok(ColumnInfo {
                name,
                data_type: extract_data_type(&declared),
                column_type: declared,
                nullable: notnull == 0,
                key: if pk > 0 { "PRI".to_string() } else { String::new() },
                default_value,
                extra: String::new(),
                comment: String::new(),
                ordinal: cid as u32 + 1,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let unique_columns = single_column_unique_index_columns(conn, database, table)?;
    for column in &mut columns {
        if column.key.is_empty() && unique_columns.contains(&column.name) {
            column.key = "UNI".to_string();
        }
    }

    Ok(columns)
}

/// Names of columns that are the sole column of a unique index — used to
/// mark them "UNI" in `list_columns` when they are not already the primary key.
fn single_column_unique_index_columns(
    conn: &mut Connection,
    database: &str,
    table: &str,
) -> AppResult<HashSet<String>> {
    let sql = format!("PRAGMA {}.index_list({})", quote_ident(database), quote_ident(table));
    let mut stmt = conn.prepare(&sql)?;
    // index_list columns: seq, name, unique, origin, partial
    let indexes = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let unique: i64 = row.get(2)?;
            Ok((name, unique != 0))
        })?
        .collect::<Result<Vec<(String, bool)>, _>>()?;
    drop(stmt);

    let mut result = HashSet::new();
    for (index_name, unique) in indexes {
        if !unique {
            continue;
        }
        let columns = index_info_columns(conn, database, &index_name)?;
        if let [Some(only_column)] = columns.as_slice() {
            result.insert(only_column.clone());
        }
    }
    Ok(result)
}

/// `PRAGMA <db>.index_info(<index>)` column names in `seqno` order (`None`
/// for an expression index component, which has no column name).
fn index_info_columns(conn: &mut Connection, database: &str, index: &str) -> AppResult<Vec<Option<String>>> {
    let sql = format!("PRAGMA {}.index_info({})", quote_ident(database), quote_ident(index));
    let mut stmt = conn.prepare(&sql)?;
    // index_info columns: seqno, cid, name
    let mut rows = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(2)?)))?
        .collect::<Result<Vec<(i64, Option<String>)>, _>>()?;
    rows.sort_by_key(|(seqno, _)| *seqno);
    Ok(rows.into_iter().map(|(_, name)| name).collect())
}

pub fn list_indexes(conn: &mut Connection, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    let sql = format!("PRAGMA {}.index_list({})", quote_ident(database), quote_ident(table));
    let mut stmt = conn.prepare(&sql)?;
    let indexes = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let unique: i64 = row.get(2)?;
            let origin: String = row.get(3)?;
            Ok((name, unique != 0, origin))
        })?
        .collect::<Result<Vec<(String, bool, String)>, _>>()?;
    drop(stmt);

    let mut result = Vec::with_capacity(indexes.len());
    for (name, unique, origin) in indexes {
        let columns = index_info_columns(conn, database, &name)?
            .into_iter()
            .map(|c| c.unwrap_or_else(|| "<expr>".to_string()))
            .collect();
        let index_type = match origin.as_str() {
            "u" => "unique constraint",
            "pk" => "primary key",
            _ => "index",
        }
        .to_string();
        result.push(IndexInfo {
            name,
            unique,
            columns,
            index_type,
        });
    }
    Ok(result)
}

pub fn list_foreign_keys(conn: &mut Connection, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
    let sql = format!(
        "PRAGMA {}.foreign_key_list({})",
        quote_ident(database),
        quote_ident(table)
    );
    let mut stmt = conn.prepare(&sql)?;
    // foreign_key_list columns: id, seq, table, from, to, on_update, on_delete, match
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<Result<Vec<(i64, i64, String, String, Option<String>, String, String)>, _>>()?;
    drop(stmt);

    // Group rows by `id` (rows are already ordered by id, seq).
    struct Group {
        id: i64,
        ref_table: String,
        parts: Vec<(i64, String, Option<String>)>,
        on_update: String,
        on_delete: String,
    }
    let mut groups: Vec<Group> = Vec::new();
    for (id, seq, ref_table, column, ref_column, on_update, on_delete) in rows {
        if let Some(last) = groups.last_mut() {
            if last.id == id {
                last.parts.push((seq, column, ref_column));
                continue;
            }
        }
        groups.push(Group {
            id,
            ref_table,
            parts: vec![(seq, column, ref_column)],
            on_update,
            on_delete,
        });
    }

    let mut result = Vec::with_capacity(groups.len());
    for mut group in groups {
        group.parts.sort_by_key(|(seq, _, _)| *seq);
        let columns: Vec<String> = group.parts.iter().map(|(_, c, _)| c.clone()).collect();
        let mut ref_columns: Vec<String> = group
            .parts
            .iter()
            .map(|(_, _, rc)| rc.clone().unwrap_or_default())
            .collect();

        // `to` is NULL when the foreign key targets the referenced table's
        // primary key implicitly.
        if ref_columns.iter().any(String::is_empty) {
            let pk_columns = primary_key_columns(conn, database, &group.ref_table)?;
            if pk_columns.len() == columns.len() {
                ref_columns = pk_columns;
            }
        }

        result.push(ForeignKeyInfo {
            name: format!("fk_{}", group.id),
            columns,
            ref_database: database.to_string(),
            ref_table: group.ref_table,
            ref_columns,
            on_update: group.on_update,
            on_delete: group.on_delete,
        });
    }
    Ok(result)
}

/// Primary key column names of `table`, in key order (`table_info.pk` is the
/// 1-based position of the column within the primary key, 0 when it is not part of it).
fn primary_key_columns(conn: &mut Connection, database: &str, table: &str) -> AppResult<Vec<String>> {
    let sql = format!("PRAGMA {}.table_info({})", quote_ident(database), quote_ident(table));
    let mut stmt = conn.prepare(&sql)?;
    let mut columns = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?)))?
        .collect::<Result<Vec<(i64, String)>, _>>()?
        .into_iter()
        .filter(|(pk, _)| *pk > 0)
        .collect::<Vec<_>>();
    columns.sort_by_key(|(pk, _)| *pk);
    Ok(columns.into_iter().map(|(_, name)| name).collect())
}

pub fn table_ddl(conn: &mut Connection, database: &str, table: &str) -> AppResult<String> {
    let sql = format!(
        "SELECT sql FROM {}.sqlite_master WHERE name = ? AND type IN ('table','view')",
        quote_ident(database)
    );
    conn.query_row(&sql, [table], |row| row.get::<_, String>(0))
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => AppError::Database(format!("Table or view not found: {table}")),
            other => other.into(),
        })
}
