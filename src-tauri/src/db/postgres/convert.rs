//! Converts PostgreSQL text-protocol values to JSON, quotes identifiers and
//! string literals for synthesized DDL, and rewrites `?` placeholders into the
//! server's native `$1, $2, ...` syntax.
//!
//! `Session::run` always reads results via the simple query protocol, which
//! returns every value as text — conversion is based on the column's `Type`
//! (learned from a best-effort `prepare`, see `postgres::mod`), not on the
//! wire representation.

use tokio_postgres::types::private::BytesMut;
use tokio_postgres::types::{Format, IsNull, ToSql, Type};

use crate::db::json::{bytes_to_hex, text_to_float, text_to_number};
use crate::db::{CellValue, ColumnMeta};

/// Escapes an identifier (schema/table/column name) with double quotes,
/// doubling any double quote already present.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Escapes a string literal with single quotes, doubling any single quote
/// already present (for synthesized `COMMENT ON ...` statements).
pub fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Keeps only the first whitespace-separated token of `SHOW server_version`
/// (e.g. "16.4 (Debian 16.4-1.pgdg120+1)" -> "16.4").
pub fn parse_server_version(full: &str) -> String {
    full.split_whitespace().next().unwrap_or(full).to_string()
}

/// Rewrites positional `?` placeholders into PostgreSQL's `$1, $2, ...`
/// syntax, ignoring `?` inside single- or double-quoted regions. A doubled
/// quote (`''`, `""`) is the standard escape for a literal quote and is
/// handled correctly by simply toggling the "inside a string" state on every
/// quote character encountered.
pub fn rewrite_placeholders(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len() + 8);
    let mut in_single = false;
    let mut in_double = false;
    let mut param_index = 0u32;

    for c in sql.chars() {
        match c {
            '\'' if !in_double => {
                in_single = !in_single;
                out.push(c);
            }
            '"' if !in_single => {
                in_double = !in_double;
                out.push(c);
            }
            '?' if !in_single && !in_double => {
                param_index += 1;
                out.push('$');
                out.push_str(&param_index.to_string());
            }
            _ => out.push(c),
        }
    }

    out
}

/// Column metadata for a simple-query result column. `nullable`/`unsigned`/
/// `primary_key`/`table`/`database` are not known from the text protocol —
/// the frontend only relies on those for MySQL.
pub fn column_meta(name: &str, ty: &Type) -> ColumnMeta {
    ColumnMeta {
        name: name.to_string(),
        table: None,
        database: None,
        type_name: ty.name().to_uppercase(),
        unsigned: false,
        nullable: true,
        primary_key: false,
        binary: *ty == Type::BYTEA,
    }
}

/// Converts one text-protocol cell to JSON based on its column type.
pub fn text_to_cell(text: Option<&str>, ty: &Type) -> CellValue {
    let Some(text) = text else {
        return CellValue::Null;
    };

    if *ty == Type::INT2 || *ty == Type::INT4 || *ty == Type::INT8 || *ty == Type::OID {
        text_to_number(text, false)
    } else if *ty == Type::FLOAT4 || *ty == Type::FLOAT8 {
        text_to_float(text)
    } else if *ty == Type::NUMERIC {
        CellValue::String(text.to_string())
    } else if *ty == Type::BOOL {
        CellValue::Bool(text == "t")
    } else if *ty == Type::BYTEA {
        bytea_to_cell(text)
    } else {
        // TEXT, VARCHAR, JSON/JSONB, UUID, dates and timestamps, arrays, enums, ... —
        // the text representation is already what the frontend expects.
        CellValue::String(text.to_string())
    }
}

/// `BYTEA` is sent as `\x` followed by hex digits; render it the same way as
/// every other binary value (`0x` + uppercase hex).
fn bytea_to_cell(text: &str) -> CellValue {
    match text.strip_prefix("\\x").and_then(decode_hex) {
        Some(bytes) => CellValue::String(bytes_to_hex(&bytes)),
        None => CellValue::String(text.to_string()),
    }
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

/// A parameter value sent as text, letting the server cast it to whatever
/// type the statement expects at that position (see `Session::apply`).
#[derive(Debug)]
pub struct TextParam(Option<String>);

impl ToSql for TextParam {
    fn to_sql(&self, _ty: &Type, out: &mut BytesMut) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match &self.0 {
            Some(text) => {
                out.extend_from_slice(text.as_bytes());
                Ok(IsNull::No)
            }
            None => Ok(IsNull::Yes),
        }
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        Format::Text
    }

    tokio_postgres::types::to_sql_checked!();
}

/// Converts a JSON parameter value into its text representation.
pub fn json_to_text_param(v: &CellValue) -> TextParam {
    TextParam(match v {
        CellValue::Null => None,
        CellValue::Bool(b) => Some(if *b { "true".to_string() } else { "false".to_string() }),
        CellValue::Number(n) => Some(n.to_string()),
        CellValue::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_wraps_in_double_quotes() {
        assert_eq!(quote_ident("users"), "\"users\"");
    }

    #[test]
    fn quote_ident_doubles_internal_quotes() {
        assert_eq!(quote_ident("weird\"name"), "\"weird\"\"name\"");
    }

    #[test]
    fn quote_literal_doubles_internal_single_quotes() {
        assert_eq!(quote_literal("it's"), "'it''s'");
    }

    #[test]
    fn parse_server_version_keeps_first_token() {
        assert_eq!(parse_server_version("16.4 (Debian 16.4-1.pgdg120+1)"), "16.4");
    }

    #[test]
    fn parse_server_version_single_token() {
        assert_eq!(parse_server_version("16.4"), "16.4");
    }

    #[test]
    fn rewrite_placeholders_basic() {
        assert_eq!(
            rewrite_placeholders("INSERT INTO t (a, b) VALUES (?, ?)"),
            "INSERT INTO t (a, b) VALUES ($1, $2)"
        );
    }

    #[test]
    fn rewrite_placeholders_ignores_marks_inside_single_quotes() {
        assert_eq!(
            rewrite_placeholders("SELECT '?' WHERE a = ?"),
            "SELECT '?' WHERE a = $1"
        );
    }

    #[test]
    fn rewrite_placeholders_ignores_marks_inside_double_quotes() {
        assert_eq!(
            rewrite_placeholders("SELECT \"col?\" WHERE a = ?"),
            "SELECT \"col?\" WHERE a = $1"
        );
    }

    #[test]
    fn rewrite_placeholders_handles_doubled_quote_escape() {
        assert_eq!(
            rewrite_placeholders("SELECT 'it''s ?' WHERE a = ?"),
            "SELECT 'it''s ?' WHERE a = $1"
        );
    }

    #[test]
    fn rewrite_placeholders_leaves_existing_dollar_signs_untouched() {
        assert_eq!(rewrite_placeholders("SELECT $1, ? FROM t"), "SELECT $1, $1 FROM t");
    }

    #[test]
    fn text_to_cell_null_is_json_null() {
        assert_eq!(text_to_cell(None, &Type::TEXT), CellValue::Null);
    }

    #[test]
    fn text_to_cell_integer() {
        assert_eq!(text_to_cell(Some("42"), &Type::INT4), serde_json::json!(42));
    }

    #[test]
    fn text_to_cell_bigint_beyond_safe_range_becomes_string() {
        assert_eq!(
            text_to_cell(Some("9007199254740993"), &Type::INT8),
            serde_json::json!("9007199254740993")
        );
    }

    #[test]
    fn text_to_cell_float() {
        assert_eq!(text_to_cell(Some("3.5"), &Type::FLOAT8), serde_json::json!(3.5));
    }

    #[test]
    fn text_to_cell_numeric_stays_string() {
        assert_eq!(
            text_to_cell(Some("100.50"), &Type::NUMERIC),
            serde_json::json!("100.50")
        );
    }

    #[test]
    fn text_to_cell_bool_true() {
        assert_eq!(text_to_cell(Some("t"), &Type::BOOL), serde_json::json!(true));
    }

    #[test]
    fn text_to_cell_bool_false() {
        assert_eq!(text_to_cell(Some("f"), &Type::BOOL), serde_json::json!(false));
    }

    #[test]
    fn text_to_cell_bytea_becomes_hex() {
        assert_eq!(
            text_to_cell(Some("\\xdeadbeef"), &Type::BYTEA),
            serde_json::json!("0xDEADBEEF")
        );
    }

    #[test]
    fn text_to_cell_default_branch_keeps_text() {
        assert_eq!(
            text_to_cell(Some("550e8400-e29b-41d4-a716-446655440000"), &Type::UUID),
            serde_json::json!("550e8400-e29b-41d4-a716-446655440000")
        );
    }

    #[test]
    fn column_meta_marks_bytea_as_binary() {
        let meta = column_meta("data", &Type::BYTEA);
        assert!(meta.binary);
        assert_eq!(meta.type_name, "BYTEA");
    }

    #[test]
    fn column_meta_non_binary_type() {
        let meta = column_meta("id", &Type::INT4);
        assert!(!meta.binary);
        assert_eq!(meta.type_name, "INT4");
    }

    #[test]
    fn json_to_text_param_null() {
        let TextParam(inner) = json_to_text_param(&serde_json::json!(null));
        assert_eq!(inner, None);
    }

    #[test]
    fn json_to_text_param_bool() {
        let TextParam(inner) = json_to_text_param(&serde_json::json!(true));
        assert_eq!(inner.as_deref(), Some("true"));
    }

    #[test]
    fn json_to_text_param_string_passthrough() {
        let TextParam(inner) = json_to_text_param(&serde_json::json!("hello"));
        assert_eq!(inner.as_deref(), Some("hello"));
    }

    #[test]
    fn json_to_text_param_number() {
        let TextParam(inner) = json_to_text_param(&serde_json::json!(42));
        assert_eq!(inner.as_deref(), Some("42"));
    }
}
