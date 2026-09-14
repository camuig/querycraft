//! Разбиение текста SQL на отдельные выражения.
//!
//! Учитывает строковые литералы (', ", `) с backslash-экранированием и
//! удвоенными кавычками, комментарии (`--`, `#`, `/* */`) и директиву
//! `DELIMITER`, которая меняет разделитель выражений (нужно для процедур
//! вида `DELIMITER $$ ... END$$ DELIMITER ;`).

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
}

/// Проверяет, начинается ли по смещению `pos` строка со слова `word`
/// без учёта регистра (используется для поиска `DELIMITER` в начале строки).
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

/// `true`, если байт по смещению `pos` — начало строки (после `\n`, `\r\n` или начало файла),
/// возможно с ведущими пробелами/табами.
fn is_line_start(bytes: &[u8], mut pos: usize) -> bool {
    // Отматываем назад через пробелы/табы.
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

pub fn split_statements(sql: &str) -> Vec<Statement> {
    let bytes = sql.as_bytes();
    let len = bytes.len();
    let mut result = Vec::new();

    let mut delimiter: String = ";".to_string();
    let mut state = State::Normal;
    let mut stmt_start = 0usize;
    let mut i = 0usize;

    // Флаг: встретили ли в текущем выражении хоть один "содержательный" символ
    // (не пробел и не комментарий) — чтобы отличать выражения, состоящие только
    // из комментариев (их не нужно эмитить).
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
                // Проверка DELIMITER в начале строки (регистронезависимо), только вне выражения
                // (т.е. когда с начала текущего выражения были только пробелы/комментарии).
                if is_line_start(bytes, i) && starts_with_ci(bytes, i, "delimiter") {
                    let after_kw = i + "delimiter".len();
                    // должен быть отделён пробелом/табом
                    if after_kw < len && (bytes[after_kw] == b' ' || bytes[after_kw] == b'\t') {
                        // конец строки — новый разделитель
                        let line_end = sql[after_kw..].find('\n').map(|p| after_kw + p).unwrap_or(len);
                        let new_delim = sql[after_kw..line_end].trim().to_string();
                        if !new_delim.is_empty() {
                            // Всё, что было до DELIMITER в текущем "выражении", должно быть
                            // уже выражением-разделителем (обычно тут пусто).
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
                        // `--` считается комментарием только если после него пробел/таб/EOL или конец строки
                        let after = i + 2;
                        if after >= len || bytes[after] == b' ' || bytes[after] == b'\t' || bytes[after] == b'\n' || bytes[after] == b'\r' {
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
                    _ => {
                        // Проверяем совпадение с текущим разделителем.
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
                    b'\'' if i + 1 < len && bytes[i + 1] == b'\'' => i += 2, // удвоенная кавычка
                    b'\'' => {
                        state = State::Normal;
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
            State::DoubleQuoted => {
                match bytes[i] {
                    b'\\' if i + 1 < len => i += 2,
                    b'"' if i + 1 < len && bytes[i + 1] == b'"' => i += 2,
                    b'"' => {
                        state = State::Normal;
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
            State::Backtick => {
                match bytes[i] {
                    b'\\' if i + 1 < len => i += 2,
                    b'`' if i + 1 < len && bytes[i + 1] == b'`' => i += 2,
                    b'`' => {
                        state = State::Normal;
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
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
        }
    }

    // Последнее выражение без завершающего разделителя.
    push_statement!(len);

    result
}

fn matches_delimiter(bytes: &[u8], pos: usize, delim: &[u8]) -> bool {
    if delim.is_empty() || pos + delim.len() > bytes.len() {
        return false;
    }
    &bytes[pos..pos + delim.len()] == delim
}

/// Проверяет, что в тексте выражения есть что-то, кроме комментариев и пробелов.
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
                    if after >= len || bytes[after] == b' ' || bytes[after] == b'\t' || bytes[after] == b'\n' || bytes[after] == b'\r' {
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
        split_statements(input).into_iter().map(|s| s.sql).collect()
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
        assert_eq!(
            sqls("SELECT 'a;b'; SELECT 2"),
            vec!["SELECT 'a;b'", "SELECT 2"]
        );
    }

    #[test]
    fn semicolon_inside_double_quotes_is_not_a_separator() {
        assert_eq!(
            sqls("SELECT \"a;b\"; SELECT 2"),
            vec!["SELECT \"a;b\"", "SELECT 2"]
        );
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
        // `--foo` не является комментарием по правилам MySQL (не отделён пробелом),
        // поэтому это просто два минуса в тексте выражения.
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
        assert_eq!(
            sqls("/* just a comment */; SELECT 1;"),
            vec!["SELECT 1"]
        );
    }

    #[test]
    fn delimiter_directive_for_stored_procedure() {
        let input = "DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND$$\nDELIMITER ;\nSELECT 3;";
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
        let stmts = split_statements(input);
        assert_eq!(stmts.len(), 2);
        assert_eq!(&input[stmts[0].start..stmts[0].end], "SELECT 1");
        assert_eq!(&input[stmts[1].start..stmts[1].end], "SELECT 2");
    }

    #[test]
    fn multibyte_utf8_content_is_handled() {
        let input = "SELECT 'привет'; SELECT 'мир'";
        let stmts = split_statements(input);
        assert_eq!(stmts.len(), 2);
        assert_eq!(stmts[0].sql, "SELECT 'привет'");
        assert_eq!(stmts[1].sql, "SELECT 'мир'");
        // Позиции должны быть валидными UTF-8 границами.
        assert_eq!(&input[stmts[0].start..stmts[0].end], "SELECT 'привет'");
        assert_eq!(&input[stmts[1].start..stmts[1].end], "SELECT 'мир'");
    }

    #[test]
    fn delimiter_word_not_at_line_start_is_not_a_directive() {
        // "delimiter" встречается не в начале строки — не должно ломать разбор.
        let input = "SELECT 'x delimiter y'; SELECT 1;";
        assert_eq!(sqls(input), vec!["SELECT 'x delimiter y'", "SELECT 1"]);
    }
}
