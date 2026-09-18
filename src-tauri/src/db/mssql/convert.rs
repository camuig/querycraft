//! Converts tiberius values to JSON, quotes identifiers with square brackets,
//! and rewrites `?` placeholders into the server's native `@P1, @P2, ...` syntax.
//!
//! Unlike the text-protocol backends (MySQL, PostgreSQL), tiberius already
//! decodes every cell into a typed `ColumnData` variant (`I32`, `String`,
//! `DateTime2`, ...), so conversion matches on that value directly rather
//! than on the column's SQL type. The one exception is `MONEY`/`SMALLMONEY`,
//! which tiberius decodes into the same `ColumnData::F64` as `FLOAT` —
//! telling them apart needs the column's `ColumnType` too.

use std::borrow::Cow;

use chrono::{FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use tiberius::{Column, ColumnData, ColumnType, FromSql, ToSql};

use crate::db::json::{bytes_to_hex, float_to_json, int_to_json, uint_to_json};
use crate::db::{CellValue, ColumnMeta};

/// Escapes an identifier (schema/table/column name) with square brackets,
/// doubling any closing bracket already present.
pub fn quote_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// Rewrites positional `?` placeholders into SQL Server's `@P1, @P2, ...`
/// syntax, ignoring `?` inside single-quoted strings, double-quoted
/// identifiers or `[bracket-quoted]` identifiers.
pub fn rewrite_placeholders(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len() + 8);
    let mut in_single = false;
    let mut in_double = false;
    let mut in_bracket = false;
    let mut param_index = 0u32;

    for c in sql.chars() {
        match c {
            '\'' if !in_double && !in_bracket => {
                in_single = !in_single;
                out.push(c);
            }
            '"' if !in_single && !in_bracket => {
                in_double = !in_double;
                out.push(c);
            }
            '[' if !in_single && !in_double => {
                in_bracket = true;
                out.push(c);
            }
            ']' if in_bracket => {
                in_bracket = false;
                out.push(c);
            }
            '?' if !in_single && !in_double && !in_bracket => {
                param_index += 1;
                out.push_str("@P");
                out.push_str(&param_index.to_string());
            }
            _ => out.push(c),
        }
    }

    out
}

/// The uppercase engine type name shown in the grid header.
fn type_name(ty: ColumnType) -> &'static str {
    use ColumnType::*;
    match ty {
        Null => "NULL",
        Bit | Bitn => "BIT",
        Int1 => "TINYINT",
        Int2 => "SMALLINT",
        Int4 | Intn => "INT",
        Int8 => "BIGINT",
        Datetime4 => "SMALLDATETIME",
        Float4 => "REAL",
        Float8 | Floatn => "FLOAT",
        Money | Money4 => "MONEY",
        Datetime | Datetimen => "DATETIME",
        Guid => "UNIQUEIDENTIFIER",
        Decimaln | Numericn => "DECIMAL",
        Daten => "DATE",
        Timen => "TIME",
        Datetime2 => "DATETIME2",
        DatetimeOffsetn => "DATETIMEOFFSET",
        BigVarBin => "VARBINARY",
        BigVarChar => "VARCHAR",
        BigBinary => "BINARY",
        BigChar => "CHAR",
        NVarchar => "NVARCHAR",
        NChar => "NCHAR",
        Xml => "XML",
        Udt => "UDT",
        Text => "TEXT",
        Image => "IMAGE",
        NText => "NTEXT",
        SSVariant => "SQL_VARIANT",
    }
}

fn is_binary(ty: ColumnType) -> bool {
    matches!(ty, ColumnType::BigVarBin | ColumnType::BigBinary | ColumnType::Image)
}

/// Column metadata for a result set column. `nullable` is not known from
/// tiberius's `Column` (it only reports a name and a type), so it defaults
/// to `true` like the PostgreSQL backend — the frontend only relies on it
/// for MySQL.
pub fn column_meta(column: &Column) -> ColumnMeta {
    let ty = column.column_type();
    ColumnMeta {
        binary: is_binary(ty),
        ..ColumnMeta::simple(column.name(), type_name(ty), true)
    }
}

/// Converts one decoded cell to JSON. `column_type` is only needed to tell
/// `MONEY`/`SMALLMONEY` apart from `FLOAT` (both decode into `ColumnData::F64`).
pub fn cell_to_json(column_type: ColumnType, data: &ColumnData<'static>) -> CellValue {
    match data {
        ColumnData::U8(v) => v.map(|n| uint_to_json(n as u64)).unwrap_or(CellValue::Null),
        ColumnData::I16(v) => v.map(|n| int_to_json(n as i64)).unwrap_or(CellValue::Null),
        ColumnData::I32(v) => v.map(|n| int_to_json(n as i64)).unwrap_or(CellValue::Null),
        ColumnData::I64(v) => v.map(int_to_json).unwrap_or(CellValue::Null),
        ColumnData::F32(v) => v.map(|n| float_to_json(n as f64)).unwrap_or(CellValue::Null),
        ColumnData::F64(v) => match v {
            // MONEY/SMALLMONEY have a fixed scale of 4 digits; keep it as
            // text like DECIMAL/NUMERIC rather than risking float rounding.
            Some(n) if matches!(column_type, ColumnType::Money | ColumnType::Money4) => {
                CellValue::String(format!("{n:.4}"))
            }
            Some(n) => float_to_json(*n),
            None => CellValue::Null,
        },
        ColumnData::Bit(v) => v.map(CellValue::Bool).unwrap_or(CellValue::Null),
        ColumnData::String(v) => v
            .as_ref()
            .map(|s| CellValue::String(s.to_string()))
            .unwrap_or(CellValue::Null),
        ColumnData::Guid(v) => v.map(|u| CellValue::String(u.to_string())).unwrap_or(CellValue::Null),
        ColumnData::Binary(v) => v
            .as_ref()
            .map(|b| CellValue::String(bytes_to_hex(b)))
            .unwrap_or(CellValue::Null),
        ColumnData::Numeric(v) => v.map(|n| CellValue::String(n.to_string())).unwrap_or(CellValue::Null),
        ColumnData::Xml(v) => v
            .as_ref()
            .map(|x| CellValue::String(x.to_string()))
            .unwrap_or(CellValue::Null),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            match NaiveDateTime::from_sql(data) {
                Ok(Some(dt)) => CellValue::String(format_naive_datetime(dt)),
                _ => CellValue::Null,
            }
        }
        ColumnData::Date(_) => match NaiveDate::from_sql(data) {
            Ok(Some(d)) => CellValue::String(d.format("%Y-%m-%d").to_string()),
            _ => CellValue::Null,
        },
        ColumnData::Time(_) => match NaiveTime::from_sql(data) {
            Ok(Some(t)) => CellValue::String(format_naive_time(t)),
            _ => CellValue::Null,
        },
        ColumnData::DateTimeOffset(_) => match <chrono::DateTime<FixedOffset>>::from_sql(data) {
            Ok(Some(dt)) => CellValue::String(format_offset_datetime(dt)),
            _ => CellValue::Null,
        },
    }
}

fn format_naive_datetime(dt: NaiveDateTime) -> String {
    let nanos = dt.nanosecond();
    if nanos == 0 {
        dt.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        format!("{}.{:03}", dt.format("%Y-%m-%d %H:%M:%S"), nanos / 1_000_000)
    }
}

fn format_naive_time(t: NaiveTime) -> String {
    let nanos = t.nanosecond();
    if nanos == 0 {
        t.format("%H:%M:%S").to_string()
    } else {
        format!("{}.{:03}", t.format("%H:%M:%S"), nanos / 1_000_000)
    }
}

fn format_offset_datetime(dt: chrono::DateTime<FixedOffset>) -> String {
    let nanos = dt.nanosecond();
    if nanos == 0 {
        format!("{}{}", dt.format("%Y-%m-%d %H:%M:%S"), dt.format("%:z"))
    } else {
        format!(
            "{}.{:03}{}",
            dt.format("%Y-%m-%d %H:%M:%S"),
            nanos / 1_000_000,
            dt.format("%:z")
        )
    }
}

/// A `?`-placeholder parameter bound to its native tiberius type. Numbers are
/// sent as `BIGINT`/`FLOAT` and booleans as `BIT`; strings (and anything else)
/// as `NVARCHAR`, letting the server implicitly convert into the target
/// column's type — the same spirit as the PostgreSQL backend's all-text
/// parameters, since tiberius has no untyped/text parameter kind.
#[derive(Debug, Clone)]
pub enum Param {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

impl ToSql for Param {
    fn to_sql(&self) -> ColumnData<'_> {
        match self {
            Param::Null => ColumnData::String(None),
            Param::Bool(b) => ColumnData::Bit(Some(*b)),
            Param::Int(n) => ColumnData::I64(Some(*n)),
            Param::Float(f) => ColumnData::F64(Some(*f)),
            Param::Text(s) => ColumnData::String(Some(Cow::Borrowed(s.as_str()))),
        }
    }
}

pub fn json_to_param(v: &CellValue) -> Param {
    match v {
        CellValue::Null => Param::Null,
        CellValue::Bool(b) => Param::Bool(*b),
        CellValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Param::Int(i)
            } else if let Some(f) = n.as_f64() {
                Param::Float(f)
            } else {
                Param::Null
            }
        }
        CellValue::String(s) => Param::Text(s.clone()),
        other => Param::Text(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_wraps_in_brackets() {
        assert_eq!(quote_ident("Orders"), "[Orders]");
    }

    #[test]
    fn quote_ident_doubles_internal_closing_brackets() {
        assert_eq!(quote_ident("weird]name"), "[weird]]name]");
    }

    #[test]
    fn rewrite_placeholders_basic() {
        assert_eq!(
            rewrite_placeholders("INSERT INTO t (a, b) VALUES (?, ?)"),
            "INSERT INTO t (a, b) VALUES (@P1, @P2)"
        );
    }

    #[test]
    fn rewrite_placeholders_ignores_marks_inside_single_quotes() {
        assert_eq!(
            rewrite_placeholders("SELECT '?' WHERE a = ?"),
            "SELECT '?' WHERE a = @P1"
        );
    }

    #[test]
    fn rewrite_placeholders_ignores_marks_inside_brackets() {
        assert_eq!(
            rewrite_placeholders("SELECT [col?] WHERE a = ?"),
            "SELECT [col?] WHERE a = @P1"
        );
    }

    #[test]
    fn cell_to_json_money_is_string() {
        let data = ColumnData::F64(Some(19.9));
        assert_eq!(cell_to_json(ColumnType::Money, &data), serde_json::json!("19.9000"));
    }

    #[test]
    fn cell_to_json_float_is_number() {
        let data = ColumnData::F64(Some(19.9));
        assert_eq!(cell_to_json(ColumnType::Float8, &data), serde_json::json!(19.9));
    }

    #[test]
    fn cell_to_json_null_is_json_null() {
        let data = ColumnData::I32(None);
        assert_eq!(cell_to_json(ColumnType::Int4, &data), CellValue::Null);
    }

    #[test]
    fn cell_to_json_bit_is_bool() {
        let data = ColumnData::Bit(Some(true));
        assert_eq!(cell_to_json(ColumnType::Bit, &data), serde_json::json!(true));
    }

    #[test]
    fn cell_to_json_binary_is_hex() {
        let data = ColumnData::Binary(Some(Cow::Owned(vec![0xDE, 0xAD, 0xBE, 0xEF])));
        assert_eq!(
            cell_to_json(ColumnType::BigVarBin, &data),
            serde_json::json!("0xDEADBEEF")
        );
    }

    #[test]
    fn json_to_param_null() {
        assert!(matches!(json_to_param(&serde_json::json!(null)), Param::Null));
    }

    #[test]
    fn json_to_param_bool() {
        assert!(matches!(json_to_param(&serde_json::json!(true)), Param::Bool(true)));
    }

    #[test]
    fn json_to_param_integer() {
        match json_to_param(&serde_json::json!(42)) {
            Param::Int(n) => assert_eq!(n, 42),
            other => panic!("expected Int, got {other:?}"),
        }
    }

    #[test]
    fn json_to_param_string() {
        match json_to_param(&serde_json::json!("hello")) {
            Param::Text(s) => assert_eq!(s, "hello"),
            other => panic!("expected Text, got {other:?}"),
        }
    }
}
