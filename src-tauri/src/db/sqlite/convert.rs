//! Value conversions and small SQL helpers shared by `mod.rs` and `schema.rs`.

use rusqlite::types::{Value, ValueRef};

use crate::db::json::{bytes_to_hex, float_to_json, int_to_json};
use crate::db::CellValue;

/// Escapes an identifier (database/table/index name) for use in a query with
/// double quotes, doubling any double quote already present.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The base type of a declared column type, e.g. "VARCHAR(50)" -> "varchar",
/// "INTEGER" -> "integer". SQLite column types are free-form text and may be
/// empty; an empty declaration stays empty.
pub fn extract_data_type(declared: &str) -> String {
    declared
        .split('(')
        .next()
        .unwrap_or(declared)
        .trim()
        .to_ascii_lowercase()
}

/// Converts one cell of a query result to the shared `CellValue` JSON
/// contract: `Text`/`Blob` are borrowed slices tied to the current row, so
/// this must be called while the row is still alive.
pub fn value_ref_to_json(value: ValueRef<'_>) -> CellValue {
    match value {
        ValueRef::Null => CellValue::Null,
        ValueRef::Integer(n) => int_to_json(n),
        ValueRef::Real(f) => float_to_json(f),
        ValueRef::Text(bytes) => CellValue::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => CellValue::String(bytes_to_hex(bytes)),
    }
}

/// The SQLite storage class of a non-null value ("INTEGER"/"REAL"/"TEXT"/"BLOB"),
/// plus whether it is binary data. `None` for `Null` — callers use it to find
/// the first non-null value in a column.
pub fn storage_class(value: &ValueRef<'_>) -> Option<(&'static str, bool)> {
    match value {
        ValueRef::Null => None,
        ValueRef::Integer(_) => Some(("INTEGER", false)),
        ValueRef::Real(_) => Some(("REAL", false)),
        ValueRef::Text(_) => Some(("TEXT", false)),
        ValueRef::Blob(_) => Some(("BLOB", true)),
    }
}

/// Maps a JSON cell value (the data-editing contract) to a `rusqlite` bound
/// parameter: null -> Null, bool -> Integer 0/1, integer -> Integer, other
/// numbers -> Real, string -> Text. Arrays/objects are not expected from the
/// frontend's editor but are serialized back to text rather than dropped.
pub fn json_to_value(value: &CellValue) -> Value {
    match value {
        CellValue::Null => Value::Null,
        CellValue::Bool(b) => Value::Integer(*b as i64),
        CellValue::Number(n) => n
            .as_i64()
            .map(Value::Integer)
            .or_else(|| n.as_f64().map(Value::Real))
            .unwrap_or(Value::Null),
        CellValue::String(s) => Value::Text(s.clone()),
        CellValue::Array(_) | CellValue::Object(_) => Value::Text(value.to_string()),
    }
}

/// Whether `sql` starts with `INSERT` (case-insensitive, ignoring leading
/// whitespace) — used to decide whether `last_insert_rowid()` is meaningful
/// for the statement that just ran.
pub fn is_insert_statement(sql: &str) -> bool {
    let prefix: String = sql.trim_start().chars().take(6).collect();
    prefix.eq_ignore_ascii_case("insert")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quote_ident_wraps_in_double_quotes() {
        assert_eq!(quote_ident("main"), "\"main\"");
    }

    #[test]
    fn quote_ident_doubles_internal_quotes() {
        assert_eq!(quote_ident("weird\"name"), "\"weird\"\"name\"");
    }

    #[test]
    fn extract_data_type_strips_length_and_lowercases() {
        assert_eq!(extract_data_type("VARCHAR(50)"), "varchar");
    }

    #[test]
    fn extract_data_type_without_parens() {
        assert_eq!(extract_data_type("INTEGER"), "integer");
    }

    #[test]
    fn extract_data_type_empty_declaration() {
        assert_eq!(extract_data_type(""), "");
    }

    #[test]
    fn value_ref_to_json_maps_storage_classes() {
        assert_eq!(value_ref_to_json(ValueRef::Null), CellValue::Null);
        assert_eq!(value_ref_to_json(ValueRef::Integer(42)), json!(42));
        assert_eq!(value_ref_to_json(ValueRef::Real(1.5)), json!(1.5));
        assert_eq!(value_ref_to_json(ValueRef::Text(b"hi")), json!("hi"));
        assert_eq!(value_ref_to_json(ValueRef::Blob(&[0xDE, 0xAD])), json!("0xDEAD"));
    }

    #[test]
    fn value_ref_to_json_big_integer_becomes_string() {
        assert_eq!(
            value_ref_to_json(ValueRef::Integer(i64::MAX)),
            json!(i64::MAX.to_string())
        );
    }

    #[test]
    fn storage_class_identifies_type_and_binary_flag() {
        assert_eq!(storage_class(&ValueRef::Null), None);
        assert_eq!(storage_class(&ValueRef::Integer(1)), Some(("INTEGER", false)));
        assert_eq!(storage_class(&ValueRef::Real(1.0)), Some(("REAL", false)));
        assert_eq!(storage_class(&ValueRef::Text(b"x")), Some(("TEXT", false)));
        assert_eq!(storage_class(&ValueRef::Blob(&[1])), Some(("BLOB", true)));
    }

    #[test]
    fn json_to_value_maps_scalars() {
        assert_eq!(json_to_value(&CellValue::Null), Value::Null);
        assert_eq!(json_to_value(&json!(true)), Value::Integer(1));
        assert_eq!(json_to_value(&json!(false)), Value::Integer(0));
        assert_eq!(json_to_value(&json!(42)), Value::Integer(42));
        assert_eq!(json_to_value(&json!(1.5)), Value::Real(1.5));
        assert_eq!(json_to_value(&json!("hi")), Value::Text("hi".into()));
    }

    #[test]
    fn is_insert_statement_detects_prefix_case_insensitively() {
        assert!(is_insert_statement("insert into t values (1)"));
        assert!(is_insert_statement("  INSERT INTO t VALUES (1)"));
        assert!(!is_insert_statement("UPDATE t SET x = 1"));
        assert!(!is_insert_statement("SELECT 1"));
    }
}
