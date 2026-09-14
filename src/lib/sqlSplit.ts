// Разбиение SQL-текста на отдельные выражения (statements) с учётом строк,
// комментариев и директивы DELIMITER (как в mysql CLI / DataGrip).

export interface Statement {
  /** Текст выражения, обрезанный (trim) по краям. */
  sql: string;
  /** Символьный offset начала в исходной строке (до trim). */
  from: number;
  /** Символьный offset конца (exclusive), в исходной строке (до trim). */
  to: number;
}

type ScanState = "normal" | "squote" | "dquote" | "backtick" | "linecomment" | "blockcomment";

const DELIMITER_RE = /^DELIMITER[ \t]+(\S+)/i;

function isWhitespaceChar(c: string): boolean {
  return c === " " || c === "\t" || c === "\r";
}

/**
 * Разбивает SQL-текст на отдельные выражения.
 * Пустые выражения и выражения из одних комментариев/пробелов пропускаются.
 */
export function splitStatements(sql: string): Statement[] {
  const result: Statement[] = [];
  const n = sql.length;

  let delim = ";";
  let i = 0;
  let stmtStart = 0;
  let hasContent = false;
  let lineStart = 0;
  let state: ScanState = "normal";

  const flush = (endIndex: number): void => {
    if (!hasContent) return;
    const raw = sql.slice(stmtStart, endIndex);
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    const leadingWs = raw.length - raw.trimStart().length;
    const trailingWs = raw.length - raw.trimEnd().length;
    const from = stmtStart + leadingWs;
    const to = endIndex - trailingWs;
    result.push({ sql: trimmed, from, to });
  };

  while (i < n) {
    const c = sql[i];

    if (state === "normal") {
      if (c === "\n") {
        i++;
        lineStart = i;
        continue;
      }
      if (isWhitespaceChar(c)) {
        i++;
        continue;
      }

      // DELIMITER-директива распознаётся, только если от начала строки до
      // текущей позиции были одни пробелы/табы.
      const between = sql.slice(lineStart, i);
      if (/^[ \t]*$/.test(between)) {
        const m = DELIMITER_RE.exec(sql.slice(i));
        if (m) {
          // Строка с DELIMITER не входит ни в одно выражение.
          flush(lineStart);
          let lineEnd = sql.indexOf("\n", i);
          if (lineEnd === -1) lineEnd = n;
          const lineText = sql.slice(i, lineEnd);
          const dm = DELIMITER_RE.exec(lineText);
          if (dm) delim = dm[1];
          stmtStart = lineEnd < n ? lineEnd + 1 : n;
          i = stmtStart;
          lineStart = stmtStart;
          hasContent = false;
          continue;
        }
      }

      if (c === "'") {
        state = "squote";
        hasContent = true;
        i++;
        continue;
      }
      if (c === '"') {
        state = "dquote";
        hasContent = true;
        i++;
        continue;
      }
      if (c === "`") {
        state = "backtick";
        hasContent = true;
        i++;
        continue;
      }

      if (sql.startsWith(delim, i)) {
        flush(i);
        i += delim.length;
        stmtStart = i;
        hasContent = false;
        continue;
      }

      if (c === "-" && sql[i + 1] === "-" && (i + 2 >= n || /[ \t\r\n]/.test(sql[i + 2]))) {
        state = "linecomment";
        i += 2;
        continue;
      }
      if (c === "#") {
        state = "linecomment";
        i++;
        continue;
      }
      if (c === "/" && sql[i + 1] === "*") {
        state = "blockcomment";
        i += 2;
        continue;
      }

      hasContent = true;
      i++;
      continue;
    }

    if (state === "squote" || state === "dquote" || state === "backtick") {
      const q = state === "squote" ? "'" : state === "dquote" ? '"' : "`";
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === q) {
        if (sql[i + 1] === q) {
          i += 2;
          continue;
        }
        state = "normal";
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (state === "linecomment") {
      if (c === "\n") {
        state = "normal";
        lineStart = i + 1;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // state === "blockcomment"
    if (c === "*" && sql[i + 1] === "/") {
      state = "normal";
      i += 2;
      continue;
    }
    if (c === "\n") {
      lineStart = i + 1;
    }
    i++;
  }

  flush(n);
  return result;
}

/**
 * Находит выражение, в диапазон [from, to) которого попадает pos.
 * Если pos находится в разделителе/пробелах сразу после выражения —
 * возвращает ближайшее ПРЕДЫДУЩЕЕ выражение (курсор "ещё внутри" него).
 */
export function statementAtCursor(sql: string, pos: number): Statement | null {
  const statements = splitStatements(sql);

  for (const s of statements) {
    if (pos >= s.from && pos < s.to) return s;
  }

  let best: Statement | null = null;
  for (const s of statements) {
    if (s.to <= pos && (!best || s.to > best.to)) best = s;
  }
  return best;
}
