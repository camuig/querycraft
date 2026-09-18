//! Parses one console line into command arguments, following redis-cli's
//! quoting rules, and splits a multi-line script into one statement per line
//! (mirroring `sql_split::split_statements`, but Redis has no multi-line
//! literals or statement terminator: one command is one line).

use crate::error::{AppError, AppResult};
use crate::sql_split::Statement;

fn invalid_argument() -> AppError {
    AppError::Other("Invalid argument(s)".into())
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}

/// Parses one line into binary-safe arguments: tokens are separated by
/// whitespace; a `"..."` token supports the escapes `\\`, `\"`, `\n`, `\r`,
/// `\t`, `\a`, `\b` and `\xHH`; a `'...'` token supports only `\'`; any other
/// character is copied as-is. An unterminated quote, or a quoted token with
/// no whitespace before the next one, is an error — matching redis-cli.
pub fn parse_line(line: &str) -> AppResult<Vec<Vec<u8>>> {
    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut args = Vec::new();
    let mut i = 0usize;

    while i < len {
        while i < len && is_space(bytes[i]) {
            i += 1;
        }
        if i >= len {
            break;
        }

        let arg = match bytes[i] {
            b'"' => {
                i += 1;
                let (arg, next) = parse_double_quoted(bytes, i)?;
                i = next;
                arg
            }
            b'\'' => {
                i += 1;
                let (arg, next) = parse_single_quoted(bytes, i)?;
                i = next;
                arg
            }
            _ => {
                let start = i;
                while i < len && !is_space(bytes[i]) {
                    i += 1;
                }
                bytes[start..i].to_vec()
            }
        };
        args.push(arg);
    }

    Ok(args)
}

/// Parses the body of a `"..."` token starting right after the opening quote
/// at `start`. Returns the decoded bytes and the offset right after the
/// token (past a mandatory trailing whitespace/end-of-line).
fn parse_double_quoted(bytes: &[u8], start: usize) -> AppResult<(Vec<u8>, usize)> {
    let len = bytes.len();
    let mut i = start;
    let mut arg = Vec::new();

    loop {
        if i >= len {
            return Err(invalid_argument());
        }
        match bytes[i] {
            b'"' => {
                i += 1;
                break;
            }
            b'\\' if i + 1 < len => {
                i += 1;
                match bytes[i] {
                    b'\\' => arg.push(b'\\'),
                    b'"' => arg.push(b'"'),
                    b'n' => arg.push(b'\n'),
                    b'r' => arg.push(b'\r'),
                    b't' => arg.push(b'\t'),
                    b'a' => arg.push(0x07),
                    b'b' => arg.push(0x08),
                    b'x' => {
                        if i + 2 >= len {
                            return Err(invalid_argument());
                        }
                        let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                            .ok()
                            .and_then(|s| u8::from_str_radix(s, 16).ok())
                            .ok_or_else(invalid_argument)?;
                        arg.push(hex);
                        i += 2;
                    }
                    other => {
                        // Not one of redis-cli's recognized escapes: kept literally.
                        arg.push(b'\\');
                        arg.push(other);
                    }
                }
                i += 1;
            }
            b => {
                arg.push(b);
                i += 1;
            }
        }
    }

    if i < len && !is_space(bytes[i]) {
        return Err(invalid_argument());
    }
    Ok((arg, i))
}

/// Parses the body of a `'...'` token starting right after the opening quote
/// at `start`. Only `\'` is a recognized escape; every other byte, including
/// a lone backslash, is copied as-is.
fn parse_single_quoted(bytes: &[u8], start: usize) -> AppResult<(Vec<u8>, usize)> {
    let len = bytes.len();
    let mut i = start;
    let mut arg = Vec::new();

    loop {
        if i >= len {
            return Err(invalid_argument());
        }
        match bytes[i] {
            b'\'' => {
                i += 1;
                break;
            }
            b'\\' if i + 1 < len && bytes[i + 1] == b'\'' => {
                arg.push(b'\'');
                i += 2;
            }
            b => {
                arg.push(b);
                i += 1;
            }
        }
    }

    if i < len && !is_space(bytes[i]) {
        return Err(invalid_argument());
    }
    Ok((arg, i))
}

/// Validates a `ParamStatement::sql` for a Redis/Valkey `apply`: a single
/// command word, with no embedded whitespace, uppercased for dispatch (Redis
/// command names are case-insensitive). Its arguments travel separately, in
/// `ParamStatement::params` — unlike a console line, this is never itself a
/// full command line to parse.
pub fn validate_command_word(sql: &str) -> AppResult<String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return Err(AppError::Other(format!(
            "Invalid Redis command {sql:?}: expected a single command name with no arguments"
        )));
    }
    Ok(trimmed.to_ascii_uppercase())
}

/// Splits a console script into one statement per non-blank line, skipping
/// lines whose first non-space character is `#`. Positions are byte offsets
/// into `text`, like `sql_split::split_statements`.
pub fn split_commands(text: &str) -> Vec<Statement> {
    let mut result = Vec::new();
    let mut offset = 0usize;

    for line in text.split_inclusive('\n') {
        let without_newline = line.trim_end_matches(['\n', '\r']);
        let trimmed = without_newline.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            let start_in_line = without_newline
                .find(trimmed)
                .expect("trimmed is a substring of without_newline");
            let start = offset + start_in_line;
            result.push(Statement {
                sql: trimmed.to_string(),
                start,
                end: start + trimmed.len(),
            });
        }
        offset += line.len();
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<Vec<u8>> {
        parse_line(line).unwrap()
    }

    fn strs(line: &str) -> Vec<String> {
        args(line).into_iter().map(|a| String::from_utf8(a).unwrap()).collect()
    }

    #[test]
    fn splits_on_whitespace() {
        assert_eq!(strs("SET  foo   bar"), vec!["SET", "foo", "bar"]);
    }

    #[test]
    fn empty_line_has_no_args() {
        assert!(parse_line("   ").unwrap().is_empty());
        assert!(parse_line("").unwrap().is_empty());
    }

    #[test]
    fn double_quoted_token_with_spaces() {
        assert_eq!(strs(r#"SET foo "bar baz""#), vec!["SET", "foo", "bar baz"]);
    }

    #[test]
    fn double_quoted_escapes() {
        assert_eq!(strs(r#"SET foo "a\nb\tc\\d\"e""#), vec!["SET", "foo", "a\nb\tc\\d\"e"]);
    }

    #[test]
    fn double_quoted_hex_escape() {
        assert_eq!(args(r#"SET foo "\x41\x42""#)[2], b"AB".to_vec());
    }

    #[test]
    fn double_quoted_bell_and_backspace_escapes() {
        assert_eq!(args(r#""\a\b""#)[0], vec![0x07, 0x08]);
    }

    #[test]
    fn single_quoted_only_escapes_quote() {
        assert_eq!(strs(r"SET foo 'a\'b\nc'"), vec!["SET", "foo", "a'b\\nc"]);
    }

    #[test]
    fn unterminated_double_quote_is_an_error() {
        assert!(parse_line(r#"SET foo "bar"#).is_err());
    }

    #[test]
    fn unterminated_single_quote_is_an_error() {
        assert!(parse_line("SET foo 'bar").is_err());
    }

    #[test]
    fn quoted_token_followed_by_non_space_is_an_error() {
        assert!(parse_line(r#"SET "foo"bar baz"#).is_err());
    }

    #[test]
    fn quoted_token_at_end_of_line_is_fine() {
        assert_eq!(strs(r#"SET "foo""#), vec!["SET", "foo"]);
    }

    #[test]
    fn binary_arguments_are_not_utf8() {
        let a = parse_line(r#"SET foo "\xff\xfe""#).unwrap();
        assert_eq!(a[2], vec![0xff, 0xfe]);
    }

    #[test]
    fn validate_command_word_uppercases_and_trims() {
        assert_eq!(validate_command_word("hset").unwrap(), "HSET");
        assert_eq!(validate_command_word("  Del  ").unwrap(), "DEL");
    }

    #[test]
    fn validate_command_word_rejects_empty() {
        assert!(validate_command_word("").is_err());
        assert!(validate_command_word("   ").is_err());
    }

    #[test]
    fn validate_command_word_rejects_embedded_whitespace() {
        assert!(validate_command_word("HSET foo").is_err());
        assert!(validate_command_word("CONFIG GET maxmemory").is_err());
    }

    fn split(text: &str) -> Vec<String> {
        split_commands(text).into_iter().map(|s| s.sql).collect()
    }

    #[test]
    fn split_commands_one_per_line() {
        assert_eq!(split("SET a 1\nSET b 2\n"), vec!["SET a 1", "SET b 2"]);
    }

    #[test]
    fn split_commands_skips_blank_lines() {
        assert_eq!(split("SET a 1\n\n\nSET b 2"), vec!["SET a 1", "SET b 2"]);
    }

    #[test]
    fn split_commands_skips_comment_lines() {
        assert_eq!(
            split("# a comment\nSET a 1\n  # indented comment\nSET b 2"),
            vec!["SET a 1", "SET b 2"]
        );
    }

    #[test]
    fn split_commands_trims_each_line() {
        assert_eq!(split("  SET a 1  \n"), vec!["SET a 1"]);
    }

    #[test]
    fn split_commands_positions_are_byte_offsets() {
        let text = "SET a 1\nSET b 2";
        let stmts = split_commands(text);
        assert_eq!(stmts.len(), 2);
        assert_eq!(&text[stmts[0].start..stmts[0].end], "SET a 1");
        assert_eq!(&text[stmts[1].start..stmts[1].end], "SET b 2");
    }

    #[test]
    fn split_commands_positions_skip_leading_whitespace() {
        let text = "  SET a 1\n";
        let stmts = split_commands(text);
        assert_eq!(&text[stmts[0].start..stmts[0].end], "SET a 1");
    }
}
