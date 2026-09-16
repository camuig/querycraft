//! Parses `JSONCompactEachRowWithNamesAndTypes` response bodies and maps
//! ClickHouse types and values onto the engine-agnostic `ColumnMeta` / `CellValue` contract.

use serde_json::Value;

use crate::db::json::{float_to_json, int_to_json, uint_to_json};
use crate::db::{CellValue, ColumnMeta};
use crate::error::AppResult;

/// A ClickHouse type with its `Nullable(...)` / `LowCardinality(...)` wrappers
/// peeled off, plus what those wrappers said about the column.
pub(crate) struct ParsedType {
    /// The wrapped type, native ClickHouse spelling (e.g. "UInt64", "Decimal(10, 2)").
    pub name: String,
    pub nullable: bool,
    pub unsigned: bool,
}

/// Result of parsing one `JSONCompactEachRowWithNamesAndTypes` response body.
pub(crate) struct ParsedRows {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<CellValue>>,
    pub truncated: bool,
}

/// Peels `Nullable(...)` and `LowCardinality(...)` off a ClickHouse type name,
/// in whichever order they were nested (e.g. `Nullable(LowCardinality(String))`).
pub(crate) fn parse_type(raw: &str) -> ParsedType {
    let mut current = raw.trim();
    let mut nullable = false;
    loop {
        if let Some(inner) = unwrap(current, "Nullable") {
            nullable = true;
            current = inner;
        } else if let Some(inner) = unwrap(current, "LowCardinality") {
            current = inner;
        } else {
            break;
        }
    }
    ParsedType {
        unsigned: current.starts_with("UInt"),
        name: current.to_string(),
        nullable,
    }
}

fn unwrap<'a>(s: &'a str, wrapper: &str) -> Option<&'a str> {
    s.strip_prefix(wrapper)?.strip_prefix('(')?.strip_suffix(')')
}

/// Parses a `JSONCompactEachRowWithNamesAndTypes` body: line 1 is a JSON
/// array of column names, line 2 a JSON array of type strings, every
/// following line a JSON array of values for one row. Rows beyond `max_rows`
/// are discarded and reported through `truncated` (the server is asked to
/// stop at `max_rows + 1`, so at most one extra row is ever read).
pub(crate) fn parse_compact_rows(body: &str, max_rows: usize) -> AppResult<ParsedRows> {
    let mut lines = body.lines().filter(|line| !line.trim().is_empty());

    let names: Vec<String> = match lines.next() {
        Some(line) => serde_json::from_str(line)?,
        None => {
            return Ok(ParsedRows {
                columns: vec![],
                rows: vec![],
                truncated: false,
            })
        }
    };
    let raw_types: Vec<String> = match lines.next() {
        Some(line) => serde_json::from_str(line)?,
        None => vec![],
    };
    let types: Vec<ParsedType> = raw_types.iter().map(|t| parse_type(t)).collect();

    let columns: Vec<ColumnMeta> = names
        .iter()
        .zip(types.iter())
        .map(|(name, ty)| {
            let mut meta = ColumnMeta::simple(name.clone(), ty.name.clone(), ty.nullable);
            meta.unsigned = ty.unsigned;
            meta
        })
        .collect();

    let mut rows = Vec::new();
    let mut truncated = false;
    for line in lines {
        let raw_values: Vec<Value> = serde_json::from_str(line)?;
        if rows.len() < max_rows {
            let row = raw_values
                .into_iter()
                .zip(types.iter())
                .map(|(value, ty)| convert_cell(value, ty))
                .collect();
            rows.push(row);
        } else {
            truncated = true;
        }
    }

    Ok(ParsedRows {
        columns,
        rows,
        truncated,
    })
}

/// Maps one JSON cell from a compact response onto the `CellValue` contract:
/// integers/floats go through the shared safe-number helpers (so values
/// beyond 2^53 become strings), decimals always become strings (`f64` cannot
/// represent them exactly), arrays/objects/tuples/maps become their JSON text
/// (`CellValue` is scalar), and everything else — strings, booleans, null,
/// already-quoted 128/256-bit integers — passes through unchanged.
fn convert_cell(value: Value, ty: &ParsedType) -> CellValue {
    match value {
        Value::Array(_) | Value::Object(_) => Value::String(value.to_string()),
        Value::Number(n) => {
            if ty.name.starts_with("UInt") {
                n.as_u64().map(uint_to_json).unwrap_or(Value::Number(n))
            } else if ty.name.starts_with("Int") {
                n.as_i64().map(int_to_json).unwrap_or(Value::Number(n))
            } else if ty.name.starts_with("Float") {
                n.as_f64().map(float_to_json).unwrap_or(Value::Number(n))
            } else if ty.name.starts_with("Decimal") {
                Value::String(n.to_string())
            } else {
                Value::Number(n)
            }
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_type_plain() {
        let ty = parse_type("String");
        assert_eq!(ty.name, "String");
        assert!(!ty.nullable);
        assert!(!ty.unsigned);
    }

    #[test]
    fn parse_type_nullable() {
        let ty = parse_type("Nullable(String)");
        assert_eq!(ty.name, "String");
        assert!(ty.nullable);
    }

    #[test]
    fn parse_type_nullable_low_cardinality() {
        let ty = parse_type("Nullable(LowCardinality(String))");
        assert_eq!(ty.name, "String");
        assert!(ty.nullable);
    }

    #[test]
    fn parse_type_low_cardinality_only() {
        let ty = parse_type("LowCardinality(String)");
        assert_eq!(ty.name, "String");
        assert!(!ty.nullable);
    }

    #[test]
    fn parse_type_unsigned_flag() {
        assert!(parse_type("UInt64").unsigned);
        assert!(parse_type("Nullable(UInt32)").unsigned);
        assert!(!parse_type("Int64").unsigned);
    }

    #[test]
    fn parse_compact_rows_basic() {
        let body = "[\"id\",\"name\"]\n[\"UInt64\",\"String\"]\n[1,\"a\"]\n[2,\"b\"]\n";
        let parsed = parse_compact_rows(body, 10).unwrap();
        assert_eq!(parsed.columns.len(), 2);
        assert_eq!(parsed.columns[0].type_name, "UInt64");
        assert!(parsed.columns[0].unsigned);
        assert_eq!(
            parsed.rows,
            vec![vec![json!(1), json!("a")], vec![json!(2), json!("b")]]
        );
        assert!(!parsed.truncated);
    }

    #[test]
    fn parse_compact_rows_decimal_becomes_string() {
        let body = "[\"amount\"]\n[\"Decimal(10, 2)\"]\n[123.45]\n";
        let parsed = parse_compact_rows(body, 10).unwrap();
        assert_eq!(parsed.rows[0][0], json!("123.45"));
    }

    #[test]
    fn parse_compact_rows_empty_body_has_no_rows() {
        let parsed = parse_compact_rows("", 10).unwrap();
        assert!(parsed.columns.is_empty());
        assert!(parsed.rows.is_empty());
        assert!(!parsed.truncated);
    }

    #[test]
    fn parse_compact_rows_truncates_beyond_max_rows() {
        let body = "[\"n\"]\n[\"UInt8\"]\n[1]\n[2]\n[3]\n";
        let parsed = parse_compact_rows(body, 2).unwrap();
        assert_eq!(parsed.rows.len(), 2);
        assert!(parsed.truncated);
    }

    #[test]
    fn parse_compact_rows_big_uint64_becomes_string() {
        let body = "[\"n\"]\n[\"UInt64\"]\n[9007199254740993]\n";
        let parsed = parse_compact_rows(body, 10).unwrap();
        assert_eq!(parsed.rows[0][0], json!("9007199254740993"));
    }

    #[test]
    fn parse_compact_rows_nested_array_becomes_json_text() {
        let body = "[\"tags\"]\n[\"Array(UInt8)\"]\n[[1,2,3]]\n";
        let parsed = parse_compact_rows(body, 10).unwrap();
        assert_eq!(parsed.rows[0][0], json!("[1,2,3]"));
    }

    #[test]
    fn parse_compact_rows_null_passes_through() {
        let body = "[\"n\"]\n[\"Nullable(String)\"]\n[null]\n";
        let parsed = parse_compact_rows(body, 10).unwrap();
        assert_eq!(parsed.rows[0][0], Value::Null);
        assert!(parsed.columns[0].nullable);
    }
}
