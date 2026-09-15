// Splits SQL text into individual statements, accounting for string literals,
// comments and the DELIMITER directive (like the mysql CLI / DataGrip).

export interface Statement {
  /** Statement text, trimmed at both ends. */
  sql: string;
  /** Character offset of the start in the source string (before trim). */
  from: number;
  /** Character offset of the end (exclusive), in the source string (before trim). */
  to: number;
}

type ScanState = "normal" | "squote" | "dquote" | "backtick" | "linecomment" | "blockcomment";

const DELIMITER_RE = /^DELIMITER[ \t]+(\S+)/i;

function isWhitespaceChar(c: string): boolean {
  return c === " " || c === "\t" || c === "\r";
}

/**
 * Splits SQL text into individual statements.
 * Empty statements, and statements consisting only of comments/whitespace, are skipped.
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

      // The DELIMITER directive is only recognized if the text from the start of
      // the line to the current position is nothing but spaces/tabs.
      const between = sql.slice(lineStart, i);
      if (/^[ \t]*$/.test(between)) {
        const m = DELIMITER_RE.exec(sql.slice(i));
        if (m) {
          // A line with DELIMITER is not part of any statement.
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
 * Finds the statement whose [from, to) range contains pos.
 * If pos is in the delimiter/whitespace right after a statement, returns the
 * nearest PRECEDING statement (the cursor is "still inside" it).
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
