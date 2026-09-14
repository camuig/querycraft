//! Конвертация значений MySQL в JSON по типу колонки и обратно (для параметров).
//!
//! Текстовый протокол (`query_iter`) возвращает почти всё как `Value::Bytes` —
//! конвертировать нужно по `column.column_type()`, а не по варианту `Value`.

use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::{Column, Value};
use serde::{Deserialize, Serialize};

/// Значение ячейки в JSON: null | number | string | boolean (контракт `CellValue`).
pub type CellValue = serde_json::Value;

/// Наибольшее целое, которое JS может представить точно (2^53 - 1).
const MAX_SAFE_INT: u64 = 9_007_199_254_740_991;
/// Ограничение на размер hex-строки для бинарных значений (в hex-символах).
const MAX_HEX_CHARS: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub table: Option<String>,
    pub database: Option<String>,
    pub type_name: String,
    pub unsigned: bool,
    pub nullable: bool,
    pub primary_key: bool,
    pub binary: bool,
}

pub fn column_meta(col: &Column) -> ColumnMeta {
    let flags = col.flags();
    let binary = is_binary(col);
    let table = non_empty(col.org_table_str());
    let database = non_empty(col.schema_str());

    ColumnMeta {
        name: col.name_str().into_owned(),
        table,
        database,
        type_name: type_name(col.column_type(), binary),
        unsigned: flags.contains(ColumnFlags::UNSIGNED_FLAG),
        nullable: !flags.contains(ColumnFlags::NOT_NULL_FLAG),
        primary_key: flags.contains(ColumnFlags::PRI_KEY_FLAG),
        binary,
    }
}

fn non_empty(s: std::borrow::Cow<'_, str>) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.into_owned())
    }
}

fn is_binary(col: &Column) -> bool {
    // charset 63 == "binary"
    col.flags().contains(ColumnFlags::BINARY_FLAG) && col.character_set() == 63
}

fn type_name(ct: ColumnType, binary: bool) -> String {
    use ColumnType::*;
    let s: &str = match ct {
        MYSQL_TYPE_TINY => "TINYINT",
        MYSQL_TYPE_SHORT => "SMALLINT",
        MYSQL_TYPE_LONG => "INT",
        MYSQL_TYPE_LONGLONG => "BIGINT",
        MYSQL_TYPE_INT24 => "MEDIUMINT",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "DECIMAL",
        MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING => "VARCHAR",
        MYSQL_TYPE_STRING => "CHAR",
        MYSQL_TYPE_TINY_BLOB => {
            if binary {
                "TINYBLOB"
            } else {
                "TINYTEXT"
            }
        }
        MYSQL_TYPE_MEDIUM_BLOB => {
            if binary {
                "MEDIUMBLOB"
            } else {
                "MEDIUMTEXT"
            }
        }
        MYSQL_TYPE_LONG_BLOB => {
            if binary {
                "LONGBLOB"
            } else {
                "LONGTEXT"
            }
        }
        MYSQL_TYPE_BLOB => {
            if binary {
                "BLOB"
            } else {
                "TEXT"
            }
        }
        MYSQL_TYPE_NEWDATE => "DATE",
        MYSQL_TYPE_TIMESTAMP2 => "TIMESTAMP",
        MYSQL_TYPE_DATETIME2 => "DATETIME",
        MYSQL_TYPE_TIME2 => "TIME",
        MYSQL_TYPE_FLOAT => "FLOAT",
        MYSQL_TYPE_DOUBLE => "DOUBLE",
        MYSQL_TYPE_NULL => "NULL",
        MYSQL_TYPE_TIMESTAMP => "TIMESTAMP",
        MYSQL_TYPE_DATE => "DATE",
        MYSQL_TYPE_TIME => "TIME",
        MYSQL_TYPE_DATETIME => "DATETIME",
        MYSQL_TYPE_YEAR => "YEAR",
        MYSQL_TYPE_BIT => "BIT",
        MYSQL_TYPE_JSON => "JSON",
        MYSQL_TYPE_ENUM => "ENUM",
        MYSQL_TYPE_SET => "SET",
        MYSQL_TYPE_GEOMETRY => "GEOMETRY",
        MYSQL_TYPE_VECTOR => "VECTOR",
        other => {
            let raw = format!("{other:?}");
            return raw.strip_prefix("MYSQL_TYPE_").unwrap_or(&raw).to_string();
        }
    };
    s.to_string()
}

/// Конвертирует значение ячейки в JSON, используя тип колонки для интерпретации
/// байтов текстового протокола.
pub fn value_to_json(v: &Value, col: &Column) -> serde_json::Value {
    match v {
        Value::NULL => serde_json::Value::Null,
        Value::Bytes(bytes) => bytes_value_to_json(bytes, col),
        Value::Int(n) => int_to_json(*n),
        Value::UInt(n) => uint_to_json(*n),
        Value::Float(f) => float_to_json(*f as f64),
        Value::Double(f) => float_to_json(*f),
        Value::Date(y, mo, d, h, mi, s, us) => {
            let date_only = matches!(col.column_type(), ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE);
            serde_json::Value::String(format_date(*y, *mo, *d, *h, *mi, *s, *us, date_only))
        }
        Value::Time(neg, days, h, mi, s, us) => {
            serde_json::Value::String(format_time(*neg, *days, *h, *mi, *s, *us))
        }
    }
}

fn bytes_value_to_json(bytes: &[u8], col: &Column) -> serde_json::Value {
    use ColumnType::*;
    match col.column_type() {
        MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_LONG | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_INT24
        | MYSQL_TYPE_YEAR => bytes_to_number(bytes, col.flags().contains(ColumnFlags::UNSIGNED_FLAG)),
        MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => bytes_to_float(bytes),
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => {
            serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned())
        }
        MYSQL_TYPE_BIT => bit_bytes_to_json(bytes),
        MYSQL_TYPE_DATE
        | MYSQL_TYPE_NEWDATE
        | MYSQL_TYPE_DATETIME
        | MYSQL_TYPE_DATETIME2
        | MYSQL_TYPE_TIMESTAMP
        | MYSQL_TYPE_TIMESTAMP2
        | MYSQL_TYPE_TIME
        | MYSQL_TYPE_TIME2 => serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned()),
        MYSQL_TYPE_JSON => serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned()),
        _ => {
            if is_binary(col) {
                serde_json::Value::String(bytes_to_hex(bytes))
            } else {
                serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned())
            }
        }
    }
}

/// Парсит текстовое представление целого числа и решает, влезает ли оно
/// в JS-safe-integer диапазон; если нет — отдаёт исходный текст строкой.
pub(crate) fn bytes_to_number(bytes: &[u8], unsigned: bool) -> serde_json::Value {
    let text = String::from_utf8_lossy(bytes).into_owned();
    if unsigned {
        if let Ok(n) = text.parse::<u64>() {
            return uint_to_json(n);
        }
    } else if let Ok(n) = text.parse::<i64>() {
        return int_to_json(n);
    }
    serde_json::Value::String(text)
}

pub(crate) fn bytes_to_float(bytes: &[u8]) -> serde_json::Value {
    let text = String::from_utf8_lossy(bytes).into_owned();
    match text.parse::<f64>() {
        Ok(n) => float_to_json(n),
        Err(_) => serde_json::Value::String(text),
    }
}

/// Хекс-строка вида "0xAABBCC", обрезанная до `MAX_HEX_CHARS` hex-символов
/// (добавляет "…" при обрезке).
pub(crate) fn bytes_to_hex(bytes: &[u8]) -> String {
    let truncated = bytes.len().saturating_mul(2) > MAX_HEX_CHARS;
    let take = if truncated { MAX_HEX_CHARS / 2 } else { bytes.len() };
    let mut out = String::with_capacity(2 + take * 2 + if truncated { 1 } else { 0 });
    out.push_str("0x");
    for b in &bytes[..take] {
        out.push_str(&format!("{b:02X}"));
    }
    if truncated {
        out.push('…');
    }
    out
}

fn bit_bytes_to_json(bytes: &[u8]) -> serde_json::Value {
    if bytes.len() <= 8 {
        let mut buf = [0u8; 8];
        buf[8 - bytes.len()..].copy_from_slice(bytes);
        uint_to_json(u64::from_be_bytes(buf))
    } else {
        serde_json::Value::String(bytes_to_hex(bytes))
    }
}

fn int_to_json(n: i64) -> serde_json::Value {
    if n.unsigned_abs() <= MAX_SAFE_INT {
        serde_json::Value::Number(n.into())
    } else {
        serde_json::Value::String(n.to_string())
    }
}

fn uint_to_json(n: u64) -> serde_json::Value {
    if n <= MAX_SAFE_INT {
        serde_json::Value::Number(n.into())
    } else {
        serde_json::Value::String(n.to_string())
    }
}

fn float_to_json(n: f64) -> serde_json::Value {
    if n.is_finite() {
        serde_json::Number::from_f64(n)
            .map(serde_json::Value::Number)
            .unwrap_or_else(|| serde_json::Value::String(n.to_string()))
    } else {
        serde_json::Value::String(n.to_string())
    }
}

/// `date_only` — колонка типа DATE (без времени); в этом случае, если все
/// компоненты времени нулевые, печатаем только дату.
#[allow(clippy::too_many_arguments)] // компоненты даты/времени MySQL естественно разворачиваются в отдельные поля
pub(crate) fn format_date(y: u16, mo: u8, d: u8, h: u8, mi: u8, s: u8, us: u32, date_only: bool) -> String {
    if date_only && h == 0 && mi == 0 && s == 0 && us == 0 {
        format!("{y:04}-{mo:02}-{d:02}")
    } else if us == 0 {
        format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
    } else {
        format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")
    }
}

pub(crate) fn format_time(neg: bool, days: u32, h: u8, mi: u8, s: u8, us: u32) -> String {
    let total_hours = days as u64 * 24 + h as u64;
    let sign = if neg { "-" } else { "" };
    if us == 0 {
        format!("{sign}{total_hours:02}:{mi:02}:{s:02}")
    } else {
        format!("{sign}{total_hours:02}:{mi:02}:{s:02}.{us:06}")
    }
}

/// Конвертирует JSON-значение параметра в `mysql_async::Value` для позиционных `?`.
/// Числа отправляются как целые/дробные, строки — всегда текстом (без
/// эвристики "похоже на hex" — она неоднозначна с обычными строковыми значениями).
pub fn json_to_value(v: &serde_json::Value) -> Value {
    match v {
        serde_json::Value::Null => Value::NULL,
        serde_json::Value::Bool(b) => Value::Int(if *b { 1 } else { 0 }),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Int(i)
            } else if let Some(u) = n.as_u64() {
                Value::UInt(u)
            } else if let Some(f) = n.as_f64() {
                Value::Double(f)
            } else {
                Value::NULL
            }
        }
        serde_json::Value::String(s) => Value::Bytes(s.as_bytes().to_vec()),
        other => Value::Bytes(other.to_string().into_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_to_number_small_signed() {
        assert_eq!(bytes_to_number(b"-42", false), serde_json::json!(-42));
    }

    #[test]
    fn bytes_to_number_small_unsigned() {
        assert_eq!(bytes_to_number(b"42", true), serde_json::json!(42));
    }

    #[test]
    fn bytes_to_number_beyond_safe_int_becomes_string() {
        // 2^63 - 1, гарантированно не влезает как точное f64/JS-число в контексте u64,
        // но проверим именно превышение MAX_SAFE_INT.
        let big = (MAX_SAFE_INT + 1).to_string();
        assert_eq!(bytes_to_number(big.as_bytes(), true), serde_json::json!(big));
    }

    #[test]
    fn bytes_to_number_negative_beyond_safe_int_becomes_string() {
        let big = -(MAX_SAFE_INT as i64) - 1;
        let text = big.to_string();
        assert_eq!(bytes_to_number(text.as_bytes(), false), serde_json::json!(text));
    }

    #[test]
    fn bytes_to_number_unparsable_falls_back_to_string() {
        assert_eq!(bytes_to_number(b"not-a-number", false), serde_json::json!("not-a-number"));
    }

    #[test]
    fn bytes_to_float_basic() {
        assert_eq!(bytes_to_float(b"3.5"), serde_json::json!(3.5));
    }

    #[test]
    fn bytes_to_float_unparsable_falls_back_to_string() {
        assert_eq!(bytes_to_float(b"abc"), serde_json::json!("abc"));
    }

    #[test]
    fn bytes_to_hex_basic() {
        assert_eq!(bytes_to_hex(&[0xDE, 0xAD, 0xBE, 0xEF]), "0xDEADBEEF");
    }

    #[test]
    fn bytes_to_hex_truncates_large_input() {
        let data = vec![0xABu8; MAX_HEX_CHARS / 2 + 10];
        let hex = bytes_to_hex(&data);
        assert!(hex.ends_with('…'));
        // "0x" + MAX_HEX_CHARS hex chars + "…"
        assert_eq!(hex.chars().count(), 2 + MAX_HEX_CHARS + 1);
    }

    #[test]
    fn format_date_date_only_type_with_zero_time() {
        assert_eq!(format_date(2024, 1, 2, 0, 0, 0, 0, true), "2024-01-02");
    }

    #[test]
    fn format_date_datetime_type_even_with_zero_time() {
        assert_eq!(format_date(2024, 1, 2, 0, 0, 0, 0, false), "2024-01-02 00:00:00");
    }

    #[test]
    fn format_date_with_fractional_seconds() {
        assert_eq!(format_date(2024, 1, 2, 3, 4, 5, 6, false), "2024-01-02 03:04:05.000006");
    }

    #[test]
    fn format_time_positive_no_fraction() {
        assert_eq!(format_time(false, 0, 1, 2, 3, 0), "01:02:03");
    }

    #[test]
    fn format_time_negative_with_days_and_fraction() {
        // 1 день 2 часа => 26 часов, отрицательное время
        assert_eq!(format_time(true, 1, 2, 3, 4, 500_000), "-26:03:04.500000");
    }

    #[test]
    fn int_to_json_within_safe_range() {
        assert_eq!(int_to_json(123), serde_json::json!(123));
    }

    #[test]
    fn float_to_json_nan_becomes_string() {
        assert_eq!(float_to_json(f64::NAN), serde_json::json!("NaN"));
    }

    #[test]
    fn float_to_json_infinity_becomes_string() {
        assert_eq!(float_to_json(f64::INFINITY), serde_json::json!("inf"));
    }

    #[test]
    fn json_to_value_null() {
        assert!(matches!(json_to_value(&serde_json::json!(null)), Value::NULL));
    }

    #[test]
    fn json_to_value_string_is_bytes() {
        match json_to_value(&serde_json::json!("hello")) {
            Value::Bytes(b) => assert_eq!(b, b"hello"),
            other => panic!("expected Bytes, got {other:?}"),
        }
    }

    #[test]
    fn json_to_value_integer() {
        match json_to_value(&serde_json::json!(42)) {
            Value::Int(n) => assert_eq!(n, 42),
            other => panic!("expected Int, got {other:?}"),
        }
    }

    #[test]
    fn json_to_value_bool() {
        match json_to_value(&serde_json::json!(true)) {
            Value::Int(n) => assert_eq!(n, 1),
            other => panic!("expected Int, got {other:?}"),
        }
    }
}
