//! Splits SQL text into individual statements.
//!
//! Accounts for string literals (', ", `) with backslash escaping and
//! doubled quotes, comments (`--`, `#`, `/* */`), and the
//! `DELIMITER` directive, which changes the statement delimiter (needed for procedures
//! like `DELIMITER $$ ... END$$ DELIMITER ;`). With `dollar_quoting` on,
//! PostgreSQL dollar-quoted strings (`$$ ... $$`, `$tag$ ... $tag$`) are treated
//! as literals too, so function bodies are not split at inner semicolons.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub sql: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Normal,
    SingleQuoted,
    DoubleQuoted,
    Backtick,
    LineComment,
    BlockComment,
    /// Inside a PostgreSQL dollar-quoted string; the payload is the byte range
    /// (start, length) of the opening tag (`$$`, `$fn$`) — the closing tag must match it.
    DollarQuoted(usize, usize),
}

/// Checks whether the string at offset `pos` starts with the word `word`
/// case-insensitively (used to find `DELIMITER` at the start of a line).
fn starts_with_ci(bytes: &[u8], pos: usize, word: &str) -> bool {
    let word_bytes = word.as_bytes();
    if pos + word_bytes.len() > bytes.len() {
        return false;
    }
    bytes[pos..pos + word_bytes.len()]
        .iter()
        .zip(word_bytes.iter())
        .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

/// `true` if the byte at offset `pos` is the start of a line (after `\n`, `\r\n`, or the start of the file),
/// possibly with leading spaces/tabs.
fn is_line_start(bytes: &[u8], mut pos: usize) -> bool {
    // Scan back through spaces/tabs.
    while pos > 0 {
        let prev = bytes[pos - 1];
        if prev == b' ' || prev == b'\t' {
            pos -= 1;
        } else {
            break;
        }
    }
    pos == 0 || bytes[pos - 1] == b'\n'
}

/// Length of the dollar-quote tag starting at `pos` (`$$` -> 2, `$body$` -> 6), if any.
/// Tags follow identifier rules: letters, digits and underscores, not starting with a digit.
fn dollar_tag_len(bytes: &[u8], pos: usize) -> Option<usize> {
    if bytes.get(pos) != Some(&b'$') {
        return None;
    }
    let mut end = pos + 1;
    while end < bytes.len() {
        let b = bytes[end];
        if b == b'$' {
            return Some(end + 1 - pos);
        }
        let ident_char = b == b'_' || b.is_ascii_alphabetic() || (end > pos + 1 && b.is_ascii_digit());
        if !ident_char {
            return None;
        }
        end += 1;
    }
    None
}

/// Splits `sql` into statements. `dollar_quoting` enables PostgreSQL `$tag$ ... $tag$`
/// string literals; keep it off for MySQL, where `$` is an ordinary identifier character.
pub fn split_statements(sql: &str, dollar_quoting: bool) -> Vec<Statement> {
    let bytes = sql.as_bytes();
    let len = bytes.len();
    let mut result = Vec::new();

    let mut delimiter: String = ";".to_string();
    let mut state = State::Normal;
    let mut stmt_start = 0usize;
    let mut i = 0usize;

    // Flag: whether the current statement has any "meaningful" character yet
    // (not a space or comment) — to distinguish statements made up only
    // of comments (which shouldn't be emitted).
    macro_rules! push_statement {
        ($end:expr) => {{
            let raw = &sql[stmt_start..$end];
            let trimmed = raw.trim();
            if !trimmed.is_empty() && has_non_comment_content(trimmed) {
                let trim_start_off = raw.find(trimmed).unwrap_or(0);
                let start = stmt_start + trim_start_off;
                let end = start + trimmed.len();
                result.push(Statement {
                    sql: trimmed.to_string(),
                    start,
                    end,
                });
            }
        }};
    }

    while i < len {
        match state {
            State::Normal => {
                let b = bytes[i];
                // Check for DELIMITER at the start of a line (case-insensitively), only outside a statement
                // (i.e. only spaces/comments since the start of the current statement).
                if is_line_start(bytes, i) && starts_with_ci(bytes, i, "delimiter") {
                    let after_kw = i + "delimiter".len();
                    // must be separated by a space/tab
                    if after_kw < len && (bytes[after_kw] == b' ' || bytes[after_kw] == b'\t') {
                        // end of line — new delimiter
                        let line_end = sql[after_kw..].find('\n').map(|p| after_kw + p).unwrap_or(len);
                        let new_delim = sql[after_kw..line_end].trim().to_string();
                        if !new_delim.is_empty() {
                            // Everything before DELIMITER in the current "statement" must already be
                            // a delimiter statement (usually empty here).
                            push_statement!(i);
                            delimiter = new_delim;
                            i = if line_end < len { line_end + 1 } else { len };
                            stmt_start = i;
                            continue;
                        }
                    }
                }

                match b {
                    b'\'' => {
                        state = State::SingleQuoted;
                        i += 1;
                    }
                    b'"' => {
                        state = State::DoubleQuoted;
                        i += 1;
                    }
                    b'`' => {
                        state = State::Backtick;
                        i += 1;
                    }
                    b'-' if i + 1 < len && bytes[i + 1] == b'-' => {
                        // `--` is treated as a comment only if followed by a space/tab/EOL or end of string
                        let after = i + 2;
                        if after >= len
                            || bytes[after] == b' '
                            || bytes[after] == b'\t'
                            || bytes[after] == b'\n'
                            || bytes[after] == b'\r'
                        {
                            state = State::LineComment;
                            i += 2;
                        } else {
                            i += 1;
                        }
                    }
                    b'#' => {
                        state = State::LineComment;
                        i += 1;
                    }
                    b'/' if i + 1 < len && bytes[i + 1] == b'*' => {
                        state = State::BlockComment;
                        i += 2;
                    }
                    b'$' if dollar_quoting && dollar_tag_len(bytes, i).is_some() => {
                        let tag_len = dollar_tag_len(bytes, i).expect("checked above");
                        state = State::DollarQuoted(i, tag_len);
                        i += tag_len;
                    }
                    _ => {
                        // Check for a match against the current delimiter.
                        if matches_delimiter(bytes, i, delimiter.as_bytes()) {
                            push_statement!(i);
                            i += delimiter.len();
                            stmt_start = i;
                        } else {
                            i += 1;
                        }
                    }
                }
            }
            State::SingleQuoted => {
                match bytes[i] {
                    b'\\' if i + 1 < len => i += 2,
                    b'\'' if i + 1 < len && bytes[i + 1] == b'\'' => i += 2, // doubled quote
                    b'\'' => {
                        state = State::Normal;
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
            State::DoubleQuoted => match bytes[i] {
                b'\\' if i + 1 < len => i += 2,
                b'"' if i + 1 < len && bytes[i + 1] == b'"' => i += 2,
                b'"' => {
                    state = State::Normal;
                    i += 1;
                }
                _ => i += 1,
            },
            State::Backtick => match bytes[i] {
                b'\\' if i + 1 < len => i += 2,
                b'`' if i + 1 < len && bytes[i + 1] == b'`' => i += 2,
                b'`' => {
                    state = State::Normal;
                    i += 1;
                }
                _ => i += 1,
            },
            State::LineComment => {
                if bytes[i] == b'\n' {
                    state = State::Normal;
                }
                i += 1;
            }
            State::BlockComment => {
                if bytes[i] == b'*' && i + 1 < len && bytes[i + 1] == b'/' {
                    state = State::Normal;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            State::DollarQuoted(tag_start, tag_len) => {
                let tag = &bytes[tag_start..tag_start + tag_len];
                if bytes[i] == b'$' && bytes[i..].starts_with(tag) {
                    state = State::Normal;
                    i += tag_len;
                } else {
                    i += 1;
                }
            }
        }
    }

    // The last statement without a trailing delimiter.
    push_statement!(len);

    result
}

fn matches_delimiter(bytes: &[u8], pos: usize, delim: &[u8]) -> bool {
    if delim.is_empty() || pos + delim.len() > bytes.len() {
        return false;
    }
    &bytes[pos..pos + delim.len()] == delim
}

/// Checks that the statement text has something besides comments and whitespace.
fn has_non_comment_content(text: &str) -> bool {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut i = 0usize;
    let mut state = State::Normal;
    while i < len {
        match state {
            State::Normal => match bytes[i] {
                b' ' | b'\t' | b'\n' | b'\r' => i += 1,
                b'-' if i + 1 < len && bytes[i + 1] == b'-' => {
                    let after = i + 2;
                    if after >= len
                        || bytes[after] == b' '
                        || bytes[after] == b'\t'
                        || bytes[after] == b'\n'
                        || bytes[after] == b'\r'
                    {
                        state = State::LineComment;
                        i += 2;
                    } else {
                        return true;
                    }
                }
                b'#' => {
                    state = State::LineComment;
                    i += 1;
                }
                b'/' if i + 1 < len && bytes[i + 1] == b'*' => {
                    state = State::BlockComment;
                    i += 2;
                }
                _ => return true,
            },
            State::LineComment => {
                if bytes[i] == b'\n' {
                    state = State::Normal;
                }
                i += 1;
            }
            State::BlockComment => {
                if bytes[i] == b'*' && i + 1 < len && bytes[i + 1] == b'/' {
                    state = State::Normal;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            _ => unreachable!(),
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqls(input: &str) -> Vec<String> {
        split_statements(input, false).into_iter().map(|s| s.sql).collect()
    }

    fn pg_sqls(input: &str) -> Vec<String> {
        split_statements(input, true).into_iter().map(|s| s.sql).collect()
    }

    #[test]
    fn empty_input() {
        assert_eq!(sqls(""), Vec::<String>::new());
    }

    #[test]
    fn single_statement_no_trailing_semicolon() {
        assert_eq!(sqls("SELECT 1"), vec!["SELECT 1"]);
    }

    #[test]
    fn single_statement_with_semicolon() {
        assert_eq!(sqls("SELECT 1;"), vec!["SELECT 1"]);
    }

    #[test]
    fn multiple_statements() {
        assert_eq!(
            sqls("SELECT 1; SELECT 2; SELECT 3"),
            vec!["SELECT 1", "SELECT 2", "SELECT 3"]
        );
    }

    #[test]
    fn empty_statements_are_skipped() {
        assert_eq!(sqls("SELECT 1;;;SELECT 2;"), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn semicolon_inside_single_quotes_is_not_a_separator() {
        assert_eq!(sqls("SELECT 'a;b'; SELECT 2"), vec!["SELECT 'a;b'", "SELECT 2"]);
    }

    #[test]
    fn semicolon_inside_double_quotes_is_not_a_separator() {
        assert_eq!(sqls("SELECT \"a;b\"; SELECT 2"), vec!["SELECT \"a;b\"", "SELECT 2"]);
    }

    #[test]
    fn semicolon_inside_backticks_is_not_a_separator() {
        assert_eq!(
            sqls("SELECT `a;b` FROM t; SELECT 2"),
            vec!["SELECT `a;b` FROM t", "SELECT 2"]
        );
    }

    #[test]
    fn backslash_escaped_quote_inside_string() {
        assert_eq!(
            sqls("SELECT 'it\\'s; here'; SELECT 2"),
            vec!["SELECT 'it\\'s; here'", "SELECT 2"]
        );
    }

    #[test]
    fn doubled_quote_inside_string() {
        assert_eq!(
            sqls("SELECT 'it''s; here'; SELECT 2"),
            vec!["SELECT 'it''s; here'", "SELECT 2"]
        );
    }

    #[test]
    fn line_comment_double_dash_is_skipped_for_separator_detection() {
        assert_eq!(
            sqls("SELECT 1; -- comment; still comment\nSELECT 2;"),
            vec!["SELECT 1", "-- comment; still comment\nSELECT 2"]
        );
    }

    #[test]
    fn double_dash_without_following_space_is_not_a_comment() {
        // `--foo` is not a comment under MySQL's rules (not followed by a space),
        // so it's just two minus signs in the statement text.
        assert_eq!(sqls("SELECT 1--2"), vec!["SELECT 1--2"]);
    }

    #[test]
    fn hash_comment() {
        assert_eq!(
            sqls("SELECT 1; # comment ; more\nSELECT 2;"),
            vec!["SELECT 1", "# comment ; more\nSELECT 2"]
        );
    }

    #[test]
    fn block_comment_with_semicolon_inside() {
        assert_eq!(
            sqls("SELECT 1; /* comment ; still comment */ SELECT 2;"),
            vec!["SELECT 1", "/* comment ; still comment */ SELECT 2"]
        );
    }

    #[test]
    fn statement_consisting_only_of_comments_is_skipped() {
        assert_eq!(
            sqls("SELECT 1; -- just a comment\n; SELECT 2;"),
            vec!["SELECT 1", "SELECT 2"]
        );
    }

    #[test]
    fn statement_consisting_only_of_block_comment_is_skipped() {
        assert_eq!(sqls("/* just a comment */; SELECT 1;"), vec!["SELECT 1"]);
    }

    #[test]
    fn delimiter_directive_for_stored_procedure() {
        let input =
            "DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND$$\nDELIMITER ;\nSELECT 3;";
        let stmts = sqls(input);
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].starts_with("CREATE PROCEDURE p()"));
        assert!(stmts[0].contains("SELECT 1;"));
        assert!(stmts[0].contains("SELECT 2;"));
        assert!(stmts[0].ends_with("END"));
        assert_eq!(stmts[1], "SELECT 3");
    }

    #[test]
    fn delimiter_directive_is_case_insensitive() {
        let input = "delimiter $$\nSELECT 1$$\nDeLiMiTeR ;\nSELECT 2;";
        assert_eq!(sqls(input), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let input = "  \n  SELECT 1  \n ; \n  SELECT 2  ";
        assert_eq!(sqls(input), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn positions_are_byte_offsets_into_original_input() {
        let input = "SELECT 1; SELECT 2";
        let stmts = split_statements(input, false);
        assert_eq!(stmts.len(), 2);
        assert_eq!(&input[stmts[0].start..stmts[0].end], "SELECT 1");
        assert_eq!(&input[stmts[1].start..stmts[1].end], "SELECT 2");
    }

    #[test]
    fn multibyte_utf8_content_is_handled() {
        let input = "SELECT 'привет'; SELECT 'мир'";
        let stmts = split_statements(input, false);
        assert_eq!(stmts.len(), 2);
        assert_eq!(stmts[0].sql, "SELECT 'привет'");
        assert_eq!(stmts[1].sql, "SELECT 'мир'");
        // Positions must be valid UTF-8 boundaries.
        assert_eq!(&input[stmts[0].start..stmts[0].end], "SELECT 'привет'");
        assert_eq!(&input[stmts[1].start..stmts[1].end], "SELECT 'мир'");
    }

    #[test]
    fn delimiter_word_not_at_line_start_is_not_a_directive() {
        // "delimiter" doesn't appear at the start of a line — shouldn't break parsing.
        let input = "SELECT 'x delimiter y'; SELECT 1;";
        assert_eq!(sqls(input), vec!["SELECT 'x delimiter y'", "SELECT 1"]);
    }

    #[test]
    fn dollar_quoted_body_is_not_split_for_postgres() {
        let input = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT f();";
        let stmts = pg_sqls(input);
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].starts_with("CREATE FUNCTION"));
        assert!(stmts[0].ends_with("LANGUAGE plpgsql"));
        assert_eq!(stmts[1], "SELECT f()");
    }

    #[test]
    fn tagged_dollar_quotes_must_match_the_opening_tag() {
        let input = "DO $body$ BEGIN PERFORM 1; SELECT '$$'; END $body$; SELECT 2";
        let stmts = pg_sqls(input);
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].starts_with("DO $body$"));
        assert_eq!(stmts[1], "SELECT 2");
    }

    #[test]
    fn dollar_sign_in_identifier_is_not_a_quote() {
        // `$1` positional parameters and `a$b` identifiers must not open a literal.
        assert_eq!(pg_sqls("SELECT $1; SELECT a$b"), vec!["SELECT $1", "SELECT a$b"]);
    }

    #[test]
    fn dollar_quoting_is_off_for_mysql() {
        assert_eq!(sqls("SELECT $$; SELECT 1"), vec!["SELECT $$", "SELECT 1"]);
    }
}
