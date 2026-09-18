//! Explorer metadata for the key-value namespace: the list of selectable
//! databases and a paginated key listing with type/length/TTL, both driven
//! off the driver's own connection.

use redis::aio::MultiplexedConnection;
use redis::Value as RedisValue;

use crate::db::schema::{KeyInfo, KeyListing};
use crate::error::AppResult;

/// Keys per `SCAN` round trip.
const SCAN_COUNT: usize = 1000;
/// `CONFIG GET databases` is unavailable on some managed services (they
/// disable `CONFIG`); Redis's compiled-in default is 16 databases.
const DEFAULT_DATABASE_COUNT: usize = 16;

/// Reads one `field:value` line out of an `INFO` reply's text (section
/// headers and blank lines are not fields), used for the server version.
pub(crate) fn info_field<'a>(text: &'a str, field: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let (key, value) = line.trim_end_matches('\r').split_once(':')?;
        (key == field).then_some(value)
    })
}

/// The `[0, 1, ..., N-1]` database indexes of the server, from `CONFIG GET
/// databases` (falls back to the default count when `CONFIG` is disabled).
pub(crate) async fn list_databases(conn: &mut MultiplexedConnection) -> AppResult<Vec<String>> {
    let count = redis::cmd("CONFIG")
        .arg("GET")
        .arg("databases")
        .query_async::<Vec<String>>(conn)
        .await
        .ok()
        .and_then(|reply| reply.get(1).and_then(|s| s.parse::<usize>().ok()))
        .unwrap_or(DEFAULT_DATABASE_COUNT);
    Ok((0..count).map(|i| i.to_string()).collect())
}

fn value_as_string(value: &RedisValue) -> String {
    match value {
        RedisValue::SimpleString(s) => s.clone(),
        RedisValue::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        _ => String::new(),
    }
}

fn value_as_len(value: &RedisValue) -> Option<u64> {
    match value {
        RedisValue::Int(n) if *n >= 0 => Some(*n as u64),
        _ => None,
    }
}

/// Whether a key type carries a meaningful length (a `TYPE` other than
/// `none`/`string` has one *shaped* by that type; a plain string uses `STRLEN`).
fn length_command(key_type: &str) -> Option<&'static str> {
    match key_type {
        "string" => Some("STRLEN"),
        "hash" => Some("HLEN"),
        "list" => Some("LLEN"),
        "set" => Some("SCARD"),
        "zset" => Some("ZCARD"),
        "stream" => Some("XLEN"),
        _ => None,
    }
}

/// Lists at most `limit` keys of `db` matching `pattern` (`*` when empty),
/// sorted by name, with their type, length and TTL. Scans in batches of
/// `SCAN_COUNT` until the cursor wraps around or more than `limit` keys have
/// been collected. Selects `db` on `conn` first — callers must serialize
/// this with any other use of the same connection.
pub(crate) async fn list_keys(
    conn: &mut MultiplexedConnection,
    db: i64,
    pattern: &str,
    limit: usize,
) -> AppResult<KeyListing> {
    redis::cmd("SELECT").arg(db).query_async::<()>(conn).await?;

    let glob = if pattern.is_empty() { "*" } else { pattern };
    let mut names: Vec<String> = Vec::new();
    let mut cursor: u64 = 0;
    loop {
        let (next_cursor, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(glob)
            .arg("COUNT")
            .arg(SCAN_COUNT)
            .query_async(conn)
            .await?;
        names.extend(batch);
        cursor = next_cursor;
        if cursor == 0 || names.len() > limit {
            break;
        }
    }

    let truncated = names.len() > limit;
    names.truncate(limit);
    names.sort();

    if names.is_empty() {
        return Ok(KeyListing {
            keys: Vec::new(),
            truncated,
        });
    }

    let mut meta_pipe = redis::pipe();
    for name in &names {
        meta_pipe.cmd("TYPE").arg(name).cmd("TTL").arg(name);
    }
    let meta: Vec<RedisValue> = meta_pipe.query_async(conn).await?;
    let key_types: Vec<String> = meta.chunks(2).map(|pair| value_as_string(&pair[0])).collect();

    // One length command per key, in the same order, so its reply lines up
    // with `names`/`key_types` by index; a type without a defined length
    // (e.g. a stray "none") still gets a placeholder command to keep that alignment.
    let mut len_pipe = redis::pipe();
    for (name, key_type) in names.iter().zip(key_types.iter()) {
        let cmd = length_command(key_type).unwrap_or("EXISTS");
        len_pipe.cmd(cmd).arg(name);
    }
    let lengths: Vec<RedisValue> = len_pipe.query_async(conn).await?;

    let keys = names
        .into_iter()
        .zip(key_types)
        .zip(meta.chunks(2))
        .zip(lengths)
        .map(|(((name, key_type), meta_pair), length_value)| {
            // TTL / EXISTS wire values: -1 (no expiry) / -2 (missing key) both map to `None`.
            let ttl = value_as_len(&meta_pair[1]);
            let length = length_command(&key_type).and(value_as_len(&length_value));
            KeyInfo {
                name,
                key_type,
                length,
                ttl,
            }
        })
        .collect();

    Ok(KeyListing { keys, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_field_reads_a_known_field() {
        let text = "# Server\r\nredis_version:7.4.0\r\nos:Linux\r\n";
        assert_eq!(info_field(text, "redis_version"), Some("7.4.0"));
    }

    #[test]
    fn info_field_missing_field_is_none() {
        assert_eq!(
            info_field("# Server\r\nredis_version:7.4.0\r\n", "valkey_version"),
            None
        );
    }

    #[test]
    fn length_command_by_type() {
        assert_eq!(length_command("string"), Some("STRLEN"));
        assert_eq!(length_command("hash"), Some("HLEN"));
        assert_eq!(length_command("stream"), Some("XLEN"));
        assert_eq!(length_command("none"), None);
    }
}
