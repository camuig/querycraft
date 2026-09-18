//! Maps a `redis::Value` reply onto the engine-agnostic `StatementResult`
//! contract. Every reply becomes rows (never an "affected" result), so the
//! grid shows exactly what redis-cli would; the column shape depends on the
//! command that produced it (see the module-level tables below) and, for
//! `SCAN`-family commands, splits into two result sets (cursor, then items).

use redis::Value as RedisValue;

use crate::db::json::{bytes_to_hex, float_to_json, int_to_json, text_to_float};
use crate::db::{CellValue, ColumnMeta, StatementResult};
use crate::error::{AppError, AppResult};

/// Converts one `ParamStatement` argument (see its doc comment in `db/mod.rs`)
/// to the bytes sent on the wire: a string as its raw UTF-8 bytes, a number as
/// its decimal text (`serde_json`'s own `Display`, which prints an integer
/// value with no trailing `.0`), a boolean as `"1"`/`"0"`. `null` and any
/// non-scalar JSON value are rejected — Redis command arguments are always scalars.
pub(crate) fn cell_to_redis_arg(value: &CellValue) -> AppResult<Vec<u8>> {
    match value {
        CellValue::String(s) => Ok(s.clone().into_bytes()),
        CellValue::Number(n) => Ok(n.to_string().into_bytes()),
        CellValue::Bool(b) => Ok(if *b { b"1".to_vec() } else { b"0".to_vec() }),
        CellValue::Null => Err(AppError::Other("Redis arguments cannot be NULL".into())),
        CellValue::Array(_) | CellValue::Object(_) => Err(AppError::Other(
            "Redis arguments must be a string, number or boolean".into(),
        )),
    }
}

/// `Array`/`Set` commands whose reply is one column per row; the column name
/// depends on what the elements represent.
fn array_column_name(command: &str) -> &'static str {
    match command {
        "KEYS" => "key",
        "SMEMBERS" | "SRANDMEMBER" | "SPOP" | "SINTER" | "SUNION" | "SDIFF" | "SMISMEMBER" | "ZRANGE" | "ZREVRANGE"
        | "ZRANGEBYSCORE" | "ZREVRANGEBYSCORE" | "ZRANGEBYLEX" | "ZREVRANGEBYLEX" | "ZRANDMEMBER" | "ZPOPMIN"
        | "ZPOPMAX" => "member",
        "LRANGE" | "LPOP" | "RPOP" | "LMPOP" | "BLPOP" | "BRPOP" => "element",
        "HKEYS" => "field",
        _ => "value",
    }
}

/// Sorted-set commands that can reply with member/score pairs.
const ZSET_SCORE_COMMANDS: &[&str] = &[
    "ZRANGE",
    "ZREVRANGE",
    "ZRANGEBYSCORE",
    "ZREVRANGEBYSCORE",
    "ZRANDMEMBER",
    "ZPOPMIN",
    "ZPOPMAX",
    "ZUNION",
    "ZINTER",
    "ZDIFF",
];

fn has_flag_arg(args: &[Vec<u8>], flag: &[u8]) -> bool {
    args.iter().any(|a| a.eq_ignore_ascii_case(flag))
}

/// The command word the shaping rules key off. Two-word commands are folded
/// into one key only for the one case that needs it (`CONFIG GET`); every
/// other multi-word command (`CLIENT LIST`, ...) falls back to the generic rules.
pub(crate) fn command_key(parts: &[Vec<u8>]) -> String {
    let first = String::from_utf8_lossy(&parts[0]).to_ascii_uppercase();
    if first == "CONFIG" {
        if let Some(second) = parts.get(1) {
            if second.eq_ignore_ascii_case(b"GET") {
                return "CONFIG GET".to_string();
            }
        }
    }
    first
}

/// `ZPOPMIN`/`ZPOPMAX` always reply with member/score pairs (they take no
/// `WITHSCORES` argument); the other zset commands only do when `WITHSCORES`
/// was passed, or — under RESP3 — when the reply already arrived as an array
/// of two-element arrays.
fn is_member_score_reply(command: &str, args: &[Vec<u8>], items: &[RedisValue]) -> bool {
    if !ZSET_SCORE_COMMANDS.contains(&command) {
        return false;
    }
    if matches!(command, "ZPOPMIN" | "ZPOPMAX") {
        return true;
    }
    if has_flag_arg(args, b"WITHSCORES") {
        return true;
    }
    !items.is_empty()
        && items
            .iter()
            .all(|v| matches!(v, RedisValue::Array(pair) if pair.len() == 2))
}

fn wants_field_value_pairs(command: &str, args: &[Vec<u8>]) -> bool {
    match command {
        "HGETALL" | "CONFIG GET" => true,
        "HRANDFIELD" => has_flag_arg(args, b"WITHVALUES"),
        _ => false,
    }
}

fn is_scalar(value: &RedisValue) -> bool {
    !matches!(value, RedisValue::Array(_) | RedisValue::Set(_) | RedisValue::Map(_))
}

/// Converts a bulk/simple string to `CellValue`: UTF-8 text as-is, anything
/// else as a `0x...` hex string (binary-safe values, e.g. serialized data).
fn text_cell(bytes: &[u8]) -> CellValue {
    match std::str::from_utf8(bytes) {
        Ok(s) => CellValue::String(s.to_string()),
        Err(_) => CellValue::String(bytes_to_hex(bytes)),
    }
}

/// One reply value as a grid cell, plus the column type name it maps to.
/// Nested values (arrays, sets, maps) become their compact JSON text.
fn cell_of(value: &RedisValue) -> (CellValue, &'static str) {
    match value {
        RedisValue::Nil => (CellValue::Null, "NULL"),
        RedisValue::Int(n) => (int_to_json(*n), "INTEGER"),
        RedisValue::Okay => (CellValue::String("OK".to_string()), "STRING"),
        RedisValue::SimpleString(s) => (CellValue::String(s.clone()), "STRING"),
        RedisValue::BulkString(bytes) => (text_cell(bytes), "STRING"),
        RedisValue::Double(f) => (float_to_json(*f), "DOUBLE"),
        RedisValue::Boolean(b) => (CellValue::Bool(*b), "BOOLEAN"),
        RedisValue::VerbatimString { text, .. } => (CellValue::String(text.clone()), "STRING"),
        RedisValue::BigNumber(raw) => (text_cell(raw), "STRING"),
        RedisValue::Attribute { data, .. } => cell_of(data),
        RedisValue::Array(_) | RedisValue::Set(_) | RedisValue::Map(_) | RedisValue::Push { .. } => {
            (CellValue::String(to_json_value(value).to_string()), "JSON")
        }
        RedisValue::ServerError(e) => (CellValue::String(format!("ERROR: {e:?}")), "STRING"),
        _ => (CellValue::String(format!("{value:?}")), "STRING"),
    }
}

/// A zset score reply, which arrives as a `Double` (RESP3) or a bulk string
/// with the score's text form (RESP2) — always parsed to a number.
fn score_cell(value: &RedisValue) -> CellValue {
    match value {
        RedisValue::Double(f) => float_to_json(*f),
        RedisValue::Int(n) => float_to_json(*n as f64),
        RedisValue::BulkString(bytes) => text_to_float(&String::from_utf8_lossy(bytes)),
        RedisValue::SimpleString(s) => text_to_float(s),
        other => cell_of(other).0,
    }
}

/// Recursively turns a `redis::Value` into JSON — used both for a "JSON"
/// cell and for reassembling a hash's flat field/value list (`XRANGE`).
fn to_json_value(value: &RedisValue) -> serde_json::Value {
    match value {
        RedisValue::Nil => serde_json::Value::Null,
        RedisValue::Array(items) | RedisValue::Set(items) => {
            serde_json::Value::Array(items.iter().map(to_json_value).collect())
        }
        RedisValue::Map(pairs) => {
            serde_json::Value::Object(pairs.iter().map(|(k, v)| (json_key(k), to_json_value(v))).collect())
        }
        RedisValue::Push { data, .. } => serde_json::Value::Array(data.iter().map(to_json_value).collect()),
        RedisValue::Attribute { data, .. } => to_json_value(data),
        other => cell_of(other).0,
    }
}

fn json_key(value: &RedisValue) -> String {
    match cell_of(value).0 {
        CellValue::String(s) => s,
        other => other.to_string(),
    }
}

/// Pairs up a flat `[a, b, a, b, ...]` reply (the RESP2 shape for hash and
/// zset-with-scores replies). An odd trailing element, which should not
/// happen, is dropped.
fn pair_up(items: Vec<RedisValue>) -> Vec<(RedisValue, RedisValue)> {
    let mut it = items.into_iter();
    let mut pairs = Vec::new();
    while let (Some(a), Some(b)) = (it.next(), it.next()) {
        pairs.push((a, b));
    }
    pairs
}

/// Unpacks a RESP3 array-of-pairs reply (`[[a, b], [a, b], ...]`); an
/// element that isn't a two-item array is skipped.
fn unpack_nested_pairs(items: Vec<RedisValue>) -> Vec<(RedisValue, RedisValue)> {
    items
        .into_iter()
        .filter_map(|item| match item {
            RedisValue::Array(mut pair) if pair.len() == 2 => {
                let second = pair.pop().unwrap();
                let first = pair.pop().unwrap();
                Some((first, second))
            }
            _ => None,
        })
        .collect()
}

/// One column, one row per element; the column's type is that of the first
/// non-null element (defaulting to STRING for an empty/all-null result).
fn array_column_result(sql: &str, column_name: &str, items: Vec<RedisValue>, max_rows: usize) -> StatementResult {
    let truncated = items.len() > max_rows;
    let type_name = items
        .iter()
        .find_map(|v| {
            let (_, t) = cell_of(v);
            (t != "NULL").then_some(t)
        })
        .unwrap_or("STRING");
    let rows = items.into_iter().take(max_rows).map(|v| vec![cell_of(&v).0]).collect();
    let column = ColumnMeta::simple(column_name, type_name, true);
    StatementResult::rows(sql, vec![column], rows, truncated)
}

fn field_value_result(sql: &str, pairs: Vec<(RedisValue, RedisValue)>, max_rows: usize) -> StatementResult {
    let truncated = pairs.len() > max_rows;
    let value_type = pairs
        .iter()
        .find_map(|(_, v)| {
            let (_, t) = cell_of(v);
            (t != "NULL").then_some(t)
        })
        .unwrap_or("STRING");
    let rows = pairs
        .into_iter()
        .take(max_rows)
        .map(|(f, v)| vec![cell_of(&f).0, cell_of(&v).0])
        .collect();
    let columns = vec![
        ColumnMeta::simple("field", "STRING", true),
        ColumnMeta::simple("value", value_type, true),
    ];
    StatementResult::rows(sql, columns, rows, truncated)
}

fn member_score_result(sql: &str, pairs: Vec<(RedisValue, RedisValue)>, max_rows: usize) -> StatementResult {
    let truncated = pairs.len() > max_rows;
    let rows = pairs
        .into_iter()
        .take(max_rows)
        .map(|(member, score)| vec![cell_of(&member).0, score_cell(&score)])
        .collect();
    let columns = vec![
        ColumnMeta::simple("member", "STRING", true),
        ColumnMeta::simple("score", "DOUBLE", true),
    ];
    StatementResult::rows(sql, columns, rows, truncated)
}

/// Fallback for arrays that hold nested structures (arrays of arrays, mixed
/// content): one `value` column, each row the element's compact JSON text.
fn generic_array_result(sql: &str, items: Vec<RedisValue>, max_rows: usize) -> StatementResult {
    let truncated = items.len() > max_rows;
    let rows = items
        .into_iter()
        .take(max_rows)
        .map(|v| vec![CellValue::String(to_json_value(&v).to_string())])
        .collect();
    let column = ColumnMeta::simple("value", "JSON", true);
    StatementResult::rows(sql, vec![column], rows, truncated)
}

fn scalar_result(sql: &str, value: &RedisValue) -> StatementResult {
    let (cell, type_name) = cell_of(value);
    let column = ColumnMeta::simple("value", type_name, true);
    StatementResult::rows(sql, vec![column], vec![vec![cell]], false)
}

/// The default shape for a command not handled by one of the specialized
/// helpers below (`SCAN`, `INFO`, `XRANGE`): a scalar reply becomes one row,
/// an `Array`/`Set` becomes rows by `array_column_name`/pairing rules above,
/// and a `Map` (RESP3) always becomes field/value rows.
fn default_result(sql: &str, command: &str, args: &[Vec<u8>], value: RedisValue, max_rows: usize) -> StatementResult {
    match value {
        RedisValue::Map(pairs) => field_value_result(sql, pairs, max_rows),
        RedisValue::Array(items) | RedisValue::Set(items) => {
            if is_member_score_reply(command, args, &items) {
                let nested =
                    !items.is_empty() && items.iter().all(|v| matches!(v, RedisValue::Array(p) if p.len() == 2));
                let pairs = if nested {
                    unpack_nested_pairs(items)
                } else {
                    pair_up(items)
                };
                member_score_result(sql, pairs, max_rows)
            } else if wants_field_value_pairs(command, args) {
                field_value_result(sql, pair_up(items), max_rows)
            } else if items.iter().all(is_scalar) {
                array_column_result(sql, array_column_name(command), items, max_rows)
            } else {
                generic_array_result(sql, items, max_rows)
            }
        }
        scalar => scalar_result(sql, &scalar),
    }
}

/// `SCAN`/`SSCAN`/`HSCAN`/`ZSCAN` reply `[cursor, items]`: split into a
/// one-row `cursor` result and a second result shaped like the matching
/// non-cursor command (`KEYS`, `SMEMBERS`, `HGETALL`, `ZRANGE ... WITHSCORES`).
fn scan_results(sql: &str, command: &str, value: RedisValue, max_rows: usize) -> Vec<StatementResult> {
    let RedisValue::Array(mut parts) = value else {
        return vec![scalar_result(sql, &value)];
    };
    if parts.len() != 2 {
        return vec![generic_array_result(sql, parts, max_rows)];
    }
    let items_value = parts.pop().expect("checked len == 2");
    let cursor_value = parts.pop().expect("checked len == 2");

    let (cursor_cell, cursor_type) = cell_of(&cursor_value);
    let cursor_result = StatementResult::rows(
        sql,
        vec![ColumnMeta::simple("cursor", cursor_type, true)],
        vec![vec![cursor_cell]],
        false,
    );

    let items = match items_value {
        RedisValue::Array(v) | RedisValue::Set(v) => v,
        other => vec![other],
    };
    let items_result = match command {
        "SCAN" => array_column_result(sql, "key", items, max_rows),
        "SSCAN" => array_column_result(sql, "member", items, max_rows),
        "HSCAN" => field_value_result(sql, pair_up(items), max_rows),
        "ZSCAN" => member_score_result(sql, pair_up(items), max_rows),
        _ => generic_array_result(sql, items, max_rows),
    };

    vec![cursor_result, items_result]
}

/// `INFO`'s reply is one bulk string with `# Section` headers and `field:value`
/// lines; parsed into `section`/`field`/`value` rows (blank lines skipped).
fn info_result(sql: &str, value: RedisValue, max_rows: usize) -> StatementResult {
    let text = match &value {
        RedisValue::BulkString(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        RedisValue::SimpleString(s) => s.clone(),
        RedisValue::VerbatimString { text, .. } => text.clone(),
        _ => return scalar_result(sql, &value),
    };

    let columns = vec![
        ColumnMeta::simple("section", "STRING", true),
        ColumnMeta::simple("field", "STRING", true),
        ColumnMeta::simple("value", "STRING", true),
    ];
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut section = String::new();

    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix("# ") {
            section = name.trim().to_string();
            continue;
        }
        let Some((field, val)) = line.split_once(':') else {
            continue;
        };
        if rows.len() < max_rows {
            rows.push(vec![
                CellValue::String(section.clone()),
                CellValue::String(field.to_string()),
                CellValue::String(val.to_string()),
            ]);
        } else {
            truncated = true;
        }
    }

    StatementResult::rows(sql, columns, rows, truncated)
}

/// `XRANGE`/`XREVRANGE` reply `[[id, [field, value, ...]], ...]`; each entry
/// becomes a row of `id` and `fields` (the flat field/value list as compact JSON).
fn xrange_result(sql: &str, value: RedisValue, max_rows: usize) -> StatementResult {
    let entries = match value {
        RedisValue::Array(v) => v,
        other => vec![other],
    };
    let columns = vec![
        ColumnMeta::simple("id", "STRING", true),
        ColumnMeta::simple("fields", "JSON", true),
    ];

    let truncated = entries.len() > max_rows;
    let rows = entries
        .into_iter()
        .take(max_rows)
        .filter_map(|entry| {
            let RedisValue::Array(mut entry) = entry else {
                return None;
            };
            if entry.len() != 2 {
                return None;
            }
            let fields_value = entry.pop().expect("checked len == 2");
            let id_value = entry.pop().expect("checked len == 2");
            let fields = match fields_value {
                RedisValue::Array(items) => serde_json::Value::Object(
                    pair_up(items)
                        .into_iter()
                        .map(|(f, v)| (json_key(&f), cell_of(&v).0))
                        .collect(),
                ),
                other => to_json_value(&other),
            };
            Some(vec![cell_of(&id_value).0, CellValue::String(fields.to_string())])
        })
        .collect();

    StatementResult::rows(sql, columns, rows, truncated)
}

/// Converts one command's reply into its `StatementResult`s. `parts` is the
/// full parsed command line (`parts[0]` the command name); `sql` is the
/// original console line, copied into every result's `sql` field.
pub fn to_results(sql: &str, parts: &[Vec<u8>], value: RedisValue, max_rows: usize) -> Vec<StatementResult> {
    let command = command_key(parts);
    let args = &parts[1..];
    match command.as_str() {
        "SCAN" | "SSCAN" | "HSCAN" | "ZSCAN" => scan_results(sql, &command, value, max_rows),
        "INFO" => vec![info_result(sql, value, max_rows)],
        "XRANGE" | "XREVRANGE" => vec![xrange_result(sql, value, max_rows)],
        _ => vec![default_result(sql, &command, args, value, max_rows)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parts(words: &[&str]) -> Vec<Vec<u8>> {
        words.iter().map(|w| w.as_bytes().to_vec()).collect()
    }

    fn bulk(s: &str) -> RedisValue {
        RedisValue::BulkString(s.as_bytes().to_vec())
    }

    #[test]
    fn get_is_a_single_value_row() {
        let r = to_results("GET k", &parts(&["GET", "k"]), bulk("v"), 500);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].columns.len(), 1);
        assert_eq!(r[0].columns[0].name, "value");
        assert_eq!(r[0].rows, vec![vec![json!("v")]]);
    }

    #[test]
    fn get_missing_key_is_null() {
        let r = to_results("GET missing", &parts(&["GET", "missing"]), RedisValue::Nil, 500);
        assert_eq!(r[0].rows, vec![vec![CellValue::Null]]);
        assert_eq!(r[0].columns[0].type_name, "NULL");
    }

    #[test]
    fn keys_is_one_key_column() {
        let value = RedisValue::Array(vec![bulk("a"), bulk("b")]);
        let r = to_results("KEYS *", &parts(&["KEYS", "*"]), value, 500);
        assert_eq!(r[0].columns[0].name, "key");
        assert_eq!(r[0].rows, vec![vec![json!("a")], vec![json!("b")]]);
    }

    #[test]
    fn smembers_is_one_member_column() {
        let value = RedisValue::Set(vec![bulk("x")]);
        let r = to_results("SMEMBERS s", &parts(&["SMEMBERS", "s"]), value, 500);
        assert_eq!(r[0].columns[0].name, "member");
    }

    #[test]
    fn hgetall_pairs_up_flat_reply_into_field_value() {
        let value = RedisValue::Array(vec![bulk("f1"), bulk("v1"), bulk("f2"), RedisValue::Int(2)]);
        let r = to_results("HGETALL h", &parts(&["HGETALL", "h"]), value, 500);
        assert_eq!(
            r[0].columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["field", "value"]
        );
        assert_eq!(
            r[0].rows,
            vec![vec![json!("f1"), json!("v1")], vec![json!("f2"), json!(2)]]
        );
    }

    #[test]
    fn config_get_is_field_value_pairs() {
        let value = RedisValue::Array(vec![bulk("maxmemory"), bulk("0")]);
        let r = to_results(
            "CONFIG GET maxmemory",
            &parts(&["CONFIG", "GET", "maxmemory"]),
            value,
            500,
        );
        assert_eq!(r[0].columns[0].name, "field");
        assert_eq!(r[0].columns[1].name, "value");
    }

    #[test]
    fn zrange_withscores_flat_reply_is_member_score() {
        let value = RedisValue::Array(vec![bulk("a"), bulk("1.5"), bulk("b"), bulk("2")]);
        let r = to_results(
            "ZRANGE z 0 -1 WITHSCORES",
            &parts(&["ZRANGE", "z", "0", "-1", "WITHSCORES"]),
            value,
            500,
        );
        assert_eq!(
            r[0].columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["member", "score"]
        );
        assert_eq!(
            r[0].rows,
            vec![vec![json!("a"), json!(1.5)], vec![json!("b"), json!(2.0)]]
        );
    }

    #[test]
    fn zrange_without_withscores_is_plain_member_list() {
        let value = RedisValue::Array(vec![bulk("a"), bulk("b")]);
        let r = to_results("ZRANGE z 0 -1", &parts(&["ZRANGE", "z", "0", "-1"]), value, 500);
        assert_eq!(r[0].columns[0].name, "member");
        assert_eq!(r[0].rows.len(), 2);
    }

    #[test]
    fn zpopmin_is_always_member_score() {
        let value = RedisValue::Array(vec![bulk("a"), bulk("3")]);
        let r = to_results("ZPOPMIN z", &parts(&["ZPOPMIN", "z"]), value, 500);
        assert_eq!(r[0].columns[1].name, "score");
        assert_eq!(r[0].rows, vec![vec![json!("a"), json!(3.0)]]);
    }

    #[test]
    fn resp3_nested_pairs_are_member_score() {
        let value = RedisValue::Array(vec![RedisValue::Array(vec![bulk("a"), RedisValue::Double(1.0)])]);
        let r = to_results("ZRANGE z 0 -1", &parts(&["ZRANGE", "z", "0", "-1"]), value, 500);
        assert_eq!(r[0].columns[1].name, "score");
        assert_eq!(r[0].rows, vec![vec![json!("a"), json!(1.0)]]);
    }

    #[test]
    fn resp3_map_is_field_value() {
        let value = RedisValue::Map(vec![(bulk("f1"), bulk("v1"))]);
        let r = to_results("HGETALL h", &parts(&["HGETALL", "h"]), value, 500);
        assert_eq!(r[0].rows, vec![vec![json!("f1"), json!("v1")]]);
    }

    #[test]
    fn scan_splits_into_cursor_and_items() {
        let value = RedisValue::Array(vec![bulk("0"), RedisValue::Array(vec![bulk("qc:1"), bulk("qc:2")])]);
        let r = to_results("SCAN 0 MATCH qc:*", &parts(&["SCAN", "0", "MATCH", "qc:*"]), value, 500);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].columns[0].name, "cursor");
        assert_eq!(r[0].rows, vec![vec![json!("0")]]);
        assert_eq!(r[1].columns[0].name, "key");
        assert_eq!(r[1].rows.len(), 2);
    }

    #[test]
    fn hscan_items_are_field_value() {
        let value = RedisValue::Array(vec![bulk("0"), RedisValue::Array(vec![bulk("f"), bulk("v")])]);
        let r = to_results("HSCAN h 0", &parts(&["HSCAN", "h", "0"]), value, 500);
        assert_eq!(
            r[1].columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["field", "value"]
        );
    }

    #[test]
    fn info_parses_sections_and_fields() {
        let text = "# Server\r\nredis_version:7.4.0\r\n\r\n# Clients\r\nconnected_clients:1\r\n";
        let r = to_results("INFO server", &parts(&["INFO", "server"]), bulk(text), 500);
        assert_eq!(
            r[0].rows,
            vec![
                vec![json!("Server"), json!("redis_version"), json!("7.4.0")],
                vec![json!("Clients"), json!("connected_clients"), json!("1")],
            ]
        );
    }

    #[test]
    fn xrange_produces_id_and_json_fields() {
        let entry = RedisValue::Array(vec![bulk("1-1"), RedisValue::Array(vec![bulk("f1"), bulk("v1")])]);
        let value = RedisValue::Array(vec![entry]);
        let r = to_results("XRANGE s - +", &parts(&["XRANGE", "s", "-", "+"]), value, 500);
        assert_eq!(
            r[0].columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["id", "fields"]
        );
        assert_eq!(r[0].rows[0][0], json!("1-1"));
        assert_eq!(r[0].rows[0][1], json!(r#"{"f1":"v1"}"#));
    }

    #[test]
    fn binary_bulk_string_becomes_hex() {
        let value = RedisValue::BulkString(vec![0xff, 0x00, 0xab]);
        let r = to_results("GET k", &parts(&["GET", "k"]), value, 500);
        assert_eq!(r[0].rows[0][0], json!("0xFF00AB"));
    }

    #[test]
    fn nested_array_reply_falls_back_to_json_rows() {
        let value = RedisValue::Array(vec![RedisValue::Array(vec![bulk("a"), bulk("b"), bulk("c")])]);
        let r = to_results("HELLO 3", &parts(&["HELLO", "3"]), value, 500);
        assert_eq!(r[0].columns[0].name, "value");
        assert_eq!(r[0].columns[0].type_name, "JSON");
        assert_eq!(r[0].rows[0][0], json!(r#"["a","b","c"]"#));
    }

    #[test]
    fn truncates_beyond_max_rows() {
        let value = RedisValue::Array(vec![bulk("a"), bulk("b"), bulk("c")]);
        let r = to_results("KEYS *", &parts(&["KEYS", "*"]), value, 2);
        assert_eq!(r[0].rows.len(), 2);
        assert!(r[0].truncated);
    }

    #[test]
    fn command_key_folds_config_get() {
        assert_eq!(command_key(&parts(&["CONFIG", "GET", "maxmemory"])), "CONFIG GET");
        assert_eq!(command_key(&parts(&["CONFIG", "SET", "maxmemory", "0"])), "CONFIG");
        assert_eq!(command_key(&parts(&["get", "k"])), "GET");
    }

    #[test]
    fn cell_to_redis_arg_string_is_raw_utf8_bytes() {
        assert_eq!(cell_to_redis_arg(&json!("hello")).unwrap(), b"hello".to_vec());
        assert_eq!(cell_to_redis_arg(&json!("café")).unwrap(), "café".as_bytes().to_vec());
    }

    #[test]
    fn cell_to_redis_arg_integer_has_no_trailing_zero() {
        assert_eq!(cell_to_redis_arg(&json!(42)).unwrap(), b"42".to_vec());
        assert_eq!(cell_to_redis_arg(&json!(-7)).unwrap(), b"-7".to_vec());
    }

    #[test]
    fn cell_to_redis_arg_float_keeps_decimal_text() {
        assert_eq!(cell_to_redis_arg(&json!(1.5)).unwrap(), b"1.5".to_vec());
    }

    #[test]
    fn cell_to_redis_arg_boolean_is_one_or_zero() {
        assert_eq!(cell_to_redis_arg(&json!(true)).unwrap(), b"1".to_vec());
        assert_eq!(cell_to_redis_arg(&json!(false)).unwrap(), b"0".to_vec());
    }

    #[test]
    fn cell_to_redis_arg_null_is_an_error() {
        assert!(cell_to_redis_arg(&CellValue::Null).is_err());
    }

    #[test]
    fn cell_to_redis_arg_nested_value_is_an_error() {
        assert!(cell_to_redis_arg(&json!([1, 2])).is_err());
        assert!(cell_to_redis_arg(&json!({"a": 1})).is_err());
    }
}
