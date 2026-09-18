//! Schema metadata via `sys.*` catalog views, queried on the driver's
//! metadata client (not a session).
//!
//! Every query is qualified with a three-part name (`[database].sys.tables`,
//! ...) instead of switching the connection's current database with `USE`.
//! Catalog views (unlike dynamic management views) support cross-database
//! three-part names reliably, and it keeps the shared metadata client
//! stateless under concurrent calls.
//!
//! `table` arrives as `schema.table` (e.g. `dbo.Orders`); it is split on the
//! *last* dot into (schema, table). A schema or table name containing a dot
//! itself is not handled — an exotic case out of scope here.

use std::collections::HashSet;

use super::convert::quote_ident;
use super::TdsClient;
use crate::db::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo, TableKind};
use crate::error::{AppError, AppResult};

fn split_schema_table(table: &str) -> (&str, &str) {
    match table.rfind('.') {
        Some(pos) => (&table[..pos], &table[pos + 1..]),
        None => ("dbo", table),
    }
}

/// User databases plus the connected one; excludes the system databases
/// (`master`/`tempdb`/`model`/`msdb`, ids 1-4) unless one of them is the
/// connected database.
pub async fn list_databases(client: &mut TdsClient) -> AppResult<Vec<String>> {
    let rows = client
        .simple_query("SELECT name FROM sys.databases WHERE database_id > 4 OR name = DB_NAME() ORDER BY name")
        .await?
        .into_first_result()
        .await?;
    Ok(rows
        .iter()
        .map(|row| row.get::<&str, _>(0).unwrap_or("").to_string())
        .collect())
}

pub async fn list_tables(client: &mut TdsClient, database: &str) -> AppResult<Vec<TableInfo>> {
    let db = quote_ident(database);
    // `sys.partitions.rows` is a regular catalog view (cheap, no data scan)
    // and — unlike `sys.dm_db_partition_stats` — supports the three-part
    // cross-database name used here.
    let sql = format!(
        "SELECT s.name, t.name, 'table', \
                CAST(ep.value AS NVARCHAR(MAX)), \
                (SELECT SUM(p.rows) FROM {db}.sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) \
         FROM {db}.sys.tables t \
         JOIN {db}.sys.schemas s ON s.schema_id = t.schema_id \
         LEFT JOIN {db}.sys.extended_properties ep \
                ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description' \
         UNION ALL \
         SELECT s.name, v.name, 'view', CAST(ep.value AS NVARCHAR(MAX)), NULL \
         FROM {db}.sys.views v \
         JOIN {db}.sys.schemas s ON s.schema_id = v.schema_id \
         LEFT JOIN {db}.sys.extended_properties ep \
                ON ep.major_id = v.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description' \
         ORDER BY 1, 2"
    );
    let rows = client.simple_query(sql).await?.into_first_result().await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let schema: &str = row.get(0).unwrap_or("");
            let name: &str = row.get(1).unwrap_or("");
            let kind_str: &str = row.get(2).unwrap_or("table");
            let comment: Option<&str> = row.get(3);
            let row_count: Option<i64> = row.get(4);

            TableInfo {
                name: format!("{schema}.{name}"),
                kind: if kind_str == "view" {
                    TableKind::View
                } else {
                    TableKind::Table
                },
                engine: None,
                rows: row_count.map(|n| n.max(0) as u64),
                comment: comment.unwrap_or_default().to_string(),
            }
        })
        .collect())
}

/// (index_name, is_primary_key, is_unique, column_name) rows for every
/// non-included index column, ordered so that same-index rows stay adjacent.
async fn index_columns(
    client: &mut TdsClient,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<Vec<(String, bool, bool, String)>> {
    let db = quote_ident(database);
    let sql = format!(
        "SELECT i.name, i.is_primary_key, i.is_unique, c.name \
         FROM {db}.sys.indexes i \
         JOIN {db}.sys.index_columns ic \
                ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 \
         JOIN {db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         JOIN {db}.sys.objects o ON o.object_id = i.object_id \
         JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = @P1 AND o.name = @P2 AND i.name IS NOT NULL \
         ORDER BY i.index_id, ic.key_ordinal"
    );
    let rows = client
        .query(sql.as_str(), &[&schema, &table])
        .await?
        .into_first_result()
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.get::<&str, _>(0).unwrap_or("").to_string(),
                row.get::<bool, _>(1).unwrap_or(false),
                row.get::<bool, _>(2).unwrap_or(false),
                row.get::<&str, _>(3).unwrap_or("").to_string(),
            )
        })
        .collect())
}

/// "PRI" / "UNI" / "MUL" column sets, in the MySQL `COLUMN_KEY` vocabulary
/// the frontend relies on (see `ColumnInfo::key`): primary-key columns,
/// columns of a single-column unique non-PK index, and columns of any other index.
async fn key_sets(
    client: &mut TdsClient,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<(HashSet<String>, HashSet<String>, HashSet<String>)> {
    let rows = index_columns(client, database, schema, table).await?;

    let mut groups: Vec<(String, bool, bool, Vec<String>)> = Vec::new();
    for (index_name, is_pk, is_unique, column) in rows {
        if let Some(last) = groups.last_mut() {
            if last.0 == index_name {
                last.3.push(column);
                continue;
            }
        }
        groups.push((index_name, is_pk, is_unique, vec![column]));
    }

    let mut pk = HashSet::new();
    let mut uni = HashSet::new();
    let mut mul = HashSet::new();
    for (_, is_pk, is_unique, columns) in groups {
        if is_pk {
            pk.extend(columns);
        } else if is_unique && columns.len() == 1 {
            uni.extend(columns);
        } else {
            mul.extend(columns);
        }
    }
    Ok((pk, uni, mul))
}

/// `nvarchar(255)`, `decimal(10,2)`, `int`, ... from the catalog's raw
/// length/precision/scale columns.
fn format_column_type(base_type: &str, max_length: i16, precision: u8, scale: u8) -> String {
    match base_type {
        "nvarchar" | "nchar" => {
            if max_length < 0 {
                format!("{base_type}(max)")
            } else {
                format!("{base_type}({})", max_length / 2)
            }
        }
        "varchar" | "char" | "varbinary" | "binary" => {
            if max_length < 0 {
                format!("{base_type}(max)")
            } else {
                format!("{base_type}({max_length})")
            }
        }
        "decimal" | "numeric" => format!("{base_type}({precision},{scale})"),
        _ => base_type.to_string(),
    }
}

pub async fn list_columns(client: &mut TdsClient, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    let (schema, name) = split_schema_table(table);
    let db = quote_ident(database);
    let sql = format!(
        "SELECT c.name, ty.name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, \
                dc.definition, CAST(ep.value AS NVARCHAR(MAX)), c.column_id \
         FROM {db}.sys.columns c \
         JOIN {db}.sys.objects o ON o.object_id = c.object_id \
         JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id \
         JOIN {db}.sys.types ty ON ty.user_type_id = c.user_type_id \
         LEFT JOIN {db}.sys.default_constraints dc ON dc.object_id = c.default_object_id \
         LEFT JOIN {db}.sys.extended_properties ep \
                ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.class = 1 AND ep.name = 'MS_Description' \
         WHERE s.name = @P1 AND o.name = @P2 \
         ORDER BY c.column_id"
    );
    let rows = client
        .query(sql.as_str(), &[&schema, &name])
        .await?
        .into_first_result()
        .await?;
    let (pk, uni, mul) = key_sets(client, database, schema, name).await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let col_name = row.get::<&str, _>(0).unwrap_or("").to_string();
            let base_type: &str = row.get(1).unwrap_or("");
            let max_length: i16 = row.get(2).unwrap_or(0);
            let precision: u8 = row.get(3).unwrap_or(0);
            let scale: u8 = row.get(4).unwrap_or(0);
            let nullable: bool = row.get(5).unwrap_or(true);
            let is_identity: bool = row.get(6).unwrap_or(false);
            let default_value: Option<String> = row.get::<&str, _>(7).map(|s| s.to_string());
            let comment: Option<String> = row.get::<&str, _>(8).map(|s| s.to_string());
            let ordinal: i32 = row.get(9).unwrap_or(0);

            let key = if pk.contains(&col_name) {
                "PRI"
            } else if uni.contains(&col_name) {
                "UNI"
            } else if mul.contains(&col_name) {
                "MUL"
            } else {
                ""
            };

            ColumnInfo {
                data_type: base_type.to_string(),
                column_type: format_column_type(base_type, max_length, precision, scale),
                name: col_name,
                nullable,
                key: key.to_string(),
                default_value,
                extra: if is_identity {
                    "auto_increment".to_string()
                } else {
                    String::new()
                },
                comment: comment.unwrap_or_default(),
                ordinal: ordinal.max(0) as u32,
            }
        })
        .collect())
}

pub async fn list_indexes(client: &mut TdsClient, database: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    let (schema, name) = split_schema_table(table);
    let db = quote_ident(database);
    let sql = format!(
        "SELECT i.name, i.is_unique, i.type_desc, c.name \
         FROM {db}.sys.indexes i \
         JOIN {db}.sys.index_columns ic \
                ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 \
         JOIN {db}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         JOIN {db}.sys.objects o ON o.object_id = i.object_id \
         JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = @P1 AND o.name = @P2 AND i.name IS NOT NULL \
         ORDER BY i.index_id, ic.key_ordinal"
    );
    let rows = client
        .query(sql.as_str(), &[&schema, &name])
        .await?
        .into_first_result()
        .await?;

    let mut result: Vec<IndexInfo> = Vec::new();
    for row in rows {
        let index_name = row.get::<&str, _>(0).unwrap_or("").to_string();
        let unique: bool = row.get(1).unwrap_or(false);
        let index_type = row.get::<&str, _>(2).unwrap_or("").to_string();
        let column = row.get::<&str, _>(3).unwrap_or("").to_string();

        if let Some(last) = result.last_mut() {
            if last.name == index_name {
                last.columns.push(column);
                continue;
            }
        }
        result.push(IndexInfo {
            name: index_name,
            unique,
            columns: vec![column],
            index_type,
        });
    }
    Ok(result)
}

/// `update_referential_action_desc`/`delete_referential_action_desc` values
/// are `NO_ACTION`, `CASCADE`, `SET_NULL`, `SET_DEFAULT` — the SQL keywords with underscores.
fn format_ref_action(desc: &str) -> String {
    desc.replace('_', " ")
}

pub async fn list_foreign_keys(client: &mut TdsClient, database: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
    let (schema, name) = split_schema_table(table);
    let db = quote_ident(database);
    let sql = format!(
        "SELECT fk.name, rs.name, rt.name, fk.update_referential_action_desc, fk.delete_referential_action_desc, \
                lc.name, rc.name \
         FROM {db}.sys.foreign_keys fk \
         JOIN {db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN {db}.sys.tables t ON t.object_id = fk.parent_object_id \
         JOIN {db}.sys.schemas s ON s.schema_id = t.schema_id \
         JOIN {db}.sys.tables rt ON rt.object_id = fk.referenced_object_id \
         JOIN {db}.sys.schemas rs ON rs.schema_id = rt.schema_id \
         JOIN {db}.sys.columns lc ON lc.object_id = fkc.parent_object_id AND lc.column_id = fkc.parent_column_id \
         JOIN {db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE s.name = @P1 AND t.name = @P2 \
         ORDER BY fk.name, fkc.constraint_column_id"
    );
    let rows = client
        .query(sql.as_str(), &[&schema, &name])
        .await?
        .into_first_result()
        .await?;

    let mut result: Vec<ForeignKeyInfo> = Vec::new();
    for row in rows {
        let fk_name = row.get::<&str, _>(0).unwrap_or("").to_string();
        let ref_schema: &str = row.get(1).unwrap_or("");
        let ref_table: &str = row.get(2).unwrap_or("");
        let on_update = format_ref_action(row.get(3).unwrap_or(""));
        let on_delete = format_ref_action(row.get(4).unwrap_or(""));
        let column = row.get::<&str, _>(5).unwrap_or("").to_string();
        let ref_column = row.get::<&str, _>(6).unwrap_or("").to_string();

        if let Some(last) = result.last_mut() {
            if last.name == fk_name {
                last.columns.push(column);
                last.ref_columns.push(ref_column);
                continue;
            }
        }
        result.push(ForeignKeyInfo {
            name: fk_name,
            columns: vec![column],
            ref_database: database.to_string(),
            ref_table: format!("{ref_schema}.{ref_table}"),
            ref_columns: vec![ref_column],
            on_update,
            on_delete,
        });
    }
    Ok(result)
}

/// SQL Server has no single `SHOW CREATE TABLE`; DDL is synthesized from the
/// catalog (columns, primary key, foreign keys) — a faithful-enough script,
/// not a verbatim SSMS "Script Table as CREATE" output. Views return their
/// real definition from `sys.sql_modules`.
pub async fn table_ddl(client: &mut TdsClient, database: &str, table: &str) -> AppResult<String> {
    let (schema, name) = split_schema_table(table);
    let db = quote_ident(database);

    let kind_sql = format!(
        "SELECT o.type FROM {db}.sys.objects o JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = @P1 AND o.name = @P2 AND o.type IN ('U', 'V')"
    );
    let row = client
        .query(kind_sql.as_str(), &[&schema, &name])
        .await?
        .into_row()
        .await?;
    let row =
        row.ok_or_else(|| AppError::Database(format!("object \"{table}\" not found in database \"{database}\"")))?;
    let obj_type: &str = row.get(0).unwrap_or("U");

    if obj_type.trim() == "V" {
        let def_sql = format!(
            "SELECT sm.definition FROM {db}.sys.sql_modules sm \
             JOIN {db}.sys.views v ON v.object_id = sm.object_id \
             JOIN {db}.sys.schemas s ON s.schema_id = v.schema_id \
             WHERE s.name = @P1 AND v.name = @P2"
        );
        let row = client
            .query(def_sql.as_str(), &[&schema, &name])
            .await?
            .into_row()
            .await?;
        let def: Option<&str> = row.as_ref().and_then(|r| r.get(0));
        return Ok(def.unwrap_or("").trim().to_string());
    }

    let columns = list_columns(client, database, table).await?;
    let mut lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut line = format!("  {} {}", quote_ident(&c.name), c.column_type);
            if !c.nullable {
                line.push_str(" NOT NULL");
            }
            if let Some(default) = &c.default_value {
                line.push_str(&format!(" DEFAULT {default}"));
            }
            line
        })
        .collect();

    let pk_cols: Vec<&str> = columns
        .iter()
        .filter(|c| c.key == "PRI")
        .map(|c| c.name.as_str())
        .collect();
    if !pk_cols.is_empty() {
        let cols_sql = pk_cols.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
        lines.push(format!("  PRIMARY KEY ({cols_sql})"));
    }

    let mut ddl = format!(
        "CREATE TABLE {}.{} (\n{}\n);",
        quote_ident(schema),
        quote_ident(name),
        lines.join(",\n")
    );

    let fks = list_foreign_keys(client, database, table).await?;
    for fk in fks {
        let (ref_schema, ref_name) = split_schema_table(&fk.ref_table);
        let cols_sql = fk.columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
        let ref_cols_sql = fk
            .ref_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        ddl.push_str(&format!(
            "\nALTER TABLE {}.{} ADD CONSTRAINT {} FOREIGN KEY ({cols_sql}) REFERENCES {}.{} ({ref_cols_sql});",
            quote_ident(schema),
            quote_ident(name),
            quote_ident(&fk.name),
            quote_ident(ref_schema),
            quote_ident(ref_name),
        ));
    }

    Ok(ddl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_schema_table_splits_on_last_dot() {
        assert_eq!(split_schema_table("dbo.Orders"), ("dbo", "Orders"));
        assert_eq!(split_schema_table("sales.invoice.detail"), ("sales.invoice", "detail"));
    }

    #[test]
    fn split_schema_table_defaults_to_dbo_without_a_dot() {
        assert_eq!(split_schema_table("Orders"), ("dbo", "Orders"));
    }

    #[test]
    fn format_ref_action_maps_underscores_to_spaces() {
        assert_eq!(format_ref_action("NO_ACTION"), "NO ACTION");
        assert_eq!(format_ref_action("SET_NULL"), "SET NULL");
        assert_eq!(format_ref_action("CASCADE"), "CASCADE");
    }

    #[test]
    fn format_column_type_sizes_nvarchar_in_characters() {
        assert_eq!(format_column_type("nvarchar", 100, 0, 0), "nvarchar(50)");
        assert_eq!(format_column_type("nvarchar", -1, 0, 0), "nvarchar(max)");
    }

    #[test]
    fn format_column_type_sizes_varchar_in_bytes() {
        assert_eq!(format_column_type("varchar", 50, 0, 0), "varchar(50)");
        assert_eq!(format_column_type("varchar", -1, 0, 0), "varchar(max)");
    }

    #[test]
    fn format_column_type_decimal_uses_precision_and_scale() {
        assert_eq!(format_column_type("decimal", 0, 10, 2), "decimal(10,2)");
    }

    #[test]
    fn format_column_type_passes_through_simple_types() {
        assert_eq!(format_column_type("int", 4, 0, 0), "int");
    }
}
