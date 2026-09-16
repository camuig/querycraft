//! Schema metadata via `pg_catalog` (on the driver's metadata client, not a session).
//!
//! PostgreSQL has no `information_schema`-only path for everything we need
//! (index/constraint definitions, view bodies), so this queries `pg_catalog`
//! directly, which also exposes storage details `information_schema` hides.

use std::collections::HashSet;

use tokio_postgres::Client;

use crate::db::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo, TableKind};
use crate::error::{AppError, AppResult};

use super::convert::{quote_ident, quote_literal};

/// Schemas shown under the connection, excluding the internal `pg_toast`/`pg_temp` namespaces.
pub async fn list_databases(client: &Client) -> AppResult<Vec<String>> {
    let rows = client
        .query(
            "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_(toast|temp)' ORDER BY nspname",
            &[],
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.get(0)).collect())
}

pub async fn list_tables(client: &Client, schema: &str) -> AppResult<Vec<TableInfo>> {
    let rows = client
        .query(
            "SELECT c.relname, c.relkind::text, c.reltuples, obj_description(c.oid, 'pg_class') \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') \
             ORDER BY c.relname",
            &[&schema],
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let name: String = row.get(0);
            let relkind: String = row.get(1);
            let reltuples: f32 = row.get(2);
            let comment: Option<String> = row.get(3);

            let kind = match relkind.as_str() {
                "v" | "m" => TableKind::View,
                _ => TableKind::Table,
            };
            let engine = match relkind.as_str() {
                "p" => Some("partitioned".to_string()),
                "m" => Some("materialized".to_string()),
                _ => None,
            };
            let rows = if reltuples >= 0.0 { Some(reltuples as u64) } else { None };

            TableInfo {
                name,
                kind,
                engine,
                rows,
                comment: comment.unwrap_or_default(),
            }
        })
        .collect())
}

const PK_COLUMNS_SQL: &str = "SELECT a.attname \
     FROM pg_index i \
     JOIN pg_class c ON c.oid = i.indrelid \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
     WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary";

const UNIQUE_COLUMNS_SQL: &str = "SELECT a.attname \
     FROM pg_index i \
     JOIN pg_class c ON c.oid = i.indrelid \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] \
     WHERE n.nspname = $1 AND c.relname = $2 AND i.indisunique AND NOT i.indisprimary AND i.indnkeyatts = 1";

const MUL_COLUMNS_SQL: &str = "SELECT DISTINCT a.attname \
     FROM pg_index i \
     JOIN pg_class c ON c.oid = i.indrelid \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] \
     WHERE n.nspname = $1 AND c.relname = $2 AND NOT i.indisprimary";

async fn column_name_set(client: &Client, schema: &str, table: &str, sql: &str) -> AppResult<HashSet<String>> {
    let rows = client.query(sql, &[&schema, &table]).await?;
    Ok(rows.into_iter().map(|row| row.get(0)).collect())
}

pub async fn list_columns(client: &Client, schema: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    let rows = client
        .query(
            "SELECT a.attname, t.typname, format_type(a.atttypid, a.atttypmod), a.attnotnull, \
                    pg_get_expr(ad.adbin, ad.adrelid), a.attidentity::text, a.attgenerated::text, \
                    col_description(c.oid, a.attnum) \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[&schema, &table],
        )
        .await?;

    // "PRI" / "UNI" / "MUL" resolved with separate queries and matched by
    // column name, rather than reproducing the whole index/constraint logic
    // in Rust; precedence between them matches the MySQL `COLUMN_KEY` vocabulary.
    let pk_cols = column_name_set(client, schema, table, PK_COLUMNS_SQL).await?;
    let uni_cols = column_name_set(client, schema, table, UNIQUE_COLUMNS_SQL).await?;
    let mul_cols = column_name_set(client, schema, table, MUL_COLUMNS_SQL).await?;

    Ok(rows
        .into_iter()
        .enumerate()
        .map(|(i, row)| {
            let name: String = row.get(0);
            let data_type: String = row.get(1);
            let column_type: String = row.get(2);
            let not_null: bool = row.get(3);
            let default_value: Option<String> = row.get(4);
            let identity: String = row.get(5);
            let generated: String = row.get(6);
            let comment: Option<String> = row.get(7);

            let key = if pk_cols.contains(&name) {
                "PRI"
            } else if uni_cols.contains(&name) {
                "UNI"
            } else if mul_cols.contains(&name) {
                "MUL"
            } else {
                ""
            };
            let extra = if !identity.is_empty() {
                "identity"
            } else if !generated.is_empty() {
                "generated"
            } else {
                ""
            };

            ColumnInfo {
                name,
                data_type,
                column_type,
                nullable: !not_null,
                key: key.to_string(),
                default_value,
                extra: extra.to_string(),
                comment: comment.unwrap_or_default(),
                ordinal: (i + 1) as u32,
            }
        })
        .collect())
}

pub async fn list_indexes(client: &Client, schema: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    let rows = client
        .query(
            "SELECT i.relname, ix.indisunique, am.amname, \
                    pg_get_indexdef(ix.indexrelid, gs.n, true) \
             FROM pg_index ix \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_am am ON am.oid = i.relam \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             CROSS JOIN LATERAL generate_series(1, ix.indnkeyatts) AS gs(n) \
             WHERE n.nspname = $1 AND t.relname = $2 \
             ORDER BY i.relname, gs.n",
            &[&schema, &table],
        )
        .await?;

    let mut result: Vec<IndexInfo> = Vec::new();
    for row in rows {
        let index_name: String = row.get(0);
        let unique: bool = row.get(1);
        let index_type: String = row.get(2);
        let column: String = row.get(3);

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

pub async fn list_foreign_keys(client: &Client, schema: &str, table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
    let rows = client
        .query(
            "SELECT con.conname, fn.nspname, fc.relname, con.confupdtype::text, con.confdeltype::text, \
                    la.attname, fa.attname \
             FROM pg_constraint con \
             JOIN pg_class c ON c.oid = con.conrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_class fc ON fc.oid = con.confrelid \
             JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
             CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(local_attnum, ref_attnum, ord) \
             JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = u.local_attnum \
             JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = u.ref_attnum \
             WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f' \
             ORDER BY con.conname, u.ord",
            &[&schema, &table],
        )
        .await?;

    let mut result: Vec<ForeignKeyInfo> = Vec::new();
    for row in rows {
        let name: String = row.get(0);
        let ref_database: String = row.get(1);
        let ref_table: String = row.get(2);
        let on_update = rule_action(row.get(3));
        let on_delete = rule_action(row.get(4));
        let column: String = row.get(5);
        let ref_column: String = row.get(6);

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

/// Maps a `pg_constraint.confupdtype`/`confdeltype` letter to its SQL action name.
fn rule_action(letter: String) -> String {
    match letter.as_str() {
        "a" => "NO ACTION",
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        other => other,
    }
    .to_string()
}

/// PostgreSQL has no `SHOW CREATE TABLE`; DDL is synthesized from `pg_catalog`.
pub async fn table_ddl(client: &Client, schema: &str, table: &str) -> AppResult<String> {
    let row = client
        .query_opt(
            "SELECT c.oid, c.relkind::text FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await?;
    let row = row.ok_or_else(|| AppError::Database(format!("relation \"{schema}.{table}\" not found")))?;
    let oid: u32 = row.get(0);
    let relkind: String = row.get(1);

    match relkind.as_str() {
        "v" => view_ddl(client, schema, table, oid, false).await,
        "m" => view_ddl(client, schema, table, oid, true).await,
        _ => table_ddl_body(client, schema, table, oid).await,
    }
}

async fn view_ddl(client: &Client, schema: &str, name: &str, oid: u32, materialized: bool) -> AppResult<String> {
    let def: String = client
        .query_one_scalar("SELECT pg_get_viewdef($1::oid, true)", &[&oid])
        .await?;
    let kind = if materialized { "MATERIALIZED VIEW" } else { "VIEW" };
    Ok(format!(
        "CREATE {kind} {}.{} AS\n{}",
        quote_ident(schema),
        quote_ident(name),
        def.trim_end()
    ))
}

async fn table_ddl_body(client: &Client, schema: &str, table: &str, oid: u32) -> AppResult<String> {
    let column_rows = client
        .query(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, \
                    pg_get_expr(ad.adbin, ad.adrelid) \
             FROM pg_attribute a \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[&oid],
        )
        .await?;

    let mut lines: Vec<String> = column_rows
        .into_iter()
        .map(|row| {
            let name: String = row.get(0);
            let column_type: String = row.get(1);
            let not_null: bool = row.get(2);
            let default_value: Option<String> = row.get(3);

            let mut line = format!("  {} {}", quote_ident(&name), column_type);
            if not_null {
                line.push_str(" NOT NULL");
            }
            if let Some(default_value) = default_value {
                line.push_str(&format!(" DEFAULT {default_value}"));
            }
            line
        })
        .collect();

    let constraint_rows = client
        .query(
            "SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint \
             WHERE conrelid = $1 ORDER BY conname",
            &[&oid],
        )
        .await?;
    for row in constraint_rows {
        let name: String = row.get(0);
        let def: String = row.get(1);
        lines.push(format!("  CONSTRAINT {} {def}", quote_ident(&name)));
    }

    let mut ddl = format!(
        "CREATE TABLE {}.{} (\n{}\n);",
        quote_ident(schema),
        quote_ident(table),
        lines.join(",\n")
    );

    // Indexes that don't already back a constraint (those are covered above).
    let index_rows = client
        .query(
            "SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i \
             WHERE i.indrelid = $1 \
               AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid) \
             ORDER BY i.indexrelid",
            &[&oid],
        )
        .await?;
    for row in index_rows {
        let def: String = row.get(0);
        ddl.push_str(&format!("\n{def};"));
    }

    let table_comment: Option<String> = client
        .query_one_scalar("SELECT obj_description($1, 'pg_class')", &[&oid])
        .await?;
    if let Some(comment) = table_comment {
        ddl.push_str(&format!(
            "\nCOMMENT ON TABLE {}.{} IS {};",
            quote_ident(schema),
            quote_ident(table),
            quote_literal(&comment)
        ));
    }

    let column_comment_rows = client
        .query(
            "SELECT a.attname, col_description($1, a.attnum) FROM pg_attribute a \
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[&oid],
        )
        .await?;
    for row in column_comment_rows {
        let name: String = row.get(0);
        let comment: Option<String> = row.get(1);
        if let Some(comment) = comment {
            ddl.push_str(&format!(
                "\nCOMMENT ON COLUMN {}.{}.{} IS {};",
                quote_ident(schema),
                quote_ident(table),
                quote_ident(&name),
                quote_literal(&comment)
            ));
        }
    }

    Ok(ddl)
}

#[cfg(test)]
mod tests {
    use super::rule_action;

    #[test]
    fn rule_action_maps_known_letters() {
        assert_eq!(rule_action("a".to_string()), "NO ACTION");
        assert_eq!(rule_action("r".to_string()), "RESTRICT");
        assert_eq!(rule_action("c".to_string()), "CASCADE");
        assert_eq!(rule_action("n".to_string()), "SET NULL");
        assert_eq!(rule_action("d".to_string()), "SET DEFAULT");
    }

    #[test]
    fn rule_action_passes_through_unknown_letters() {
        assert_eq!(rule_action("x".to_string()), "x");
    }
}
