// Builds the EXPLAIN statement for the "Explain query" / "Optimize query" features and turns the
// resulting `StatementResult` into plain text for the chat prompt. Pure functions only — the
// caller is responsible for actually running the statement (via `api.executeQuery`) and for never
// calling this for a statement it should not execute (see `explainSqlFor`'s ANALYZE guard).

import type { CellValue, ColumnMeta, DbKind, StatementResult } from "../../api/types";

const EXPLAINABLE_KEYWORDS = new Set(["select", "with", "update", "delete", "insert", "replace", "table", "values"]);

/**
 * The first keyword of a statement, after skipping leading whitespace and `--`/`/* *\/` comments.
 * Returns null when the statement has no leading keyword at all (empty, or starts with punctuation).
 */
function firstKeyword(sql: string): string | null {
  let rest = sql;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const newline = trimmed.indexOf("\n");
      rest = newline === -1 ? "" : trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      rest = end === -1 ? "" : trimmed.slice(end + 2);
      continue;
    }
    rest = trimmed;
    break;
  }
  const match = /^([A-Za-z]+)/.exec(rest);
  return match ? match[1].toUpperCase() : null;
}

/**
 * True for statements that produce a plan worth showing (SELECT-shaped reads and row-touching
 * writes). False for DDL, session/administrative statements (SET, USE, SHOW, ...), and for a
 * statement that already starts with EXPLAIN — that one is handled separately by `explainSqlFor`.
 */
export function isExplainable(sql: string): boolean {
  const keyword = firstKeyword(sql);
  return keyword !== null && EXPLAINABLE_KEYWORDS.has(keyword.toLowerCase());
}

function parseVersionTuple(version: string | null | undefined): [number, number, number] | null {
  if (!version) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(version: string | null | undefined, major: number, minor: number, patch: number): boolean {
  const tuple = parseVersionTuple(version);
  if (!tuple) return false;
  const [a, b, c] = tuple;
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}

/**
 * Builds the EXPLAIN statement to run for `sql`, or null when the engine has no usable EXPLAIN
 * (mssql, redis, valkey), the statement is not explainable (`isExplainable`), or the statement is
 * already an `EXPLAIN ANALYZE` — which actually runs the statement and so must never be executed
 * here. A statement that already starts with `EXPLAIN` (and is not ANALYZE) is returned unchanged.
 */
export function explainSqlFor(kind: DbKind, sql: string, serverVersion?: string | null): string | null {
  const stmt = sql
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
  if (!stmt) return null;

  if (firstKeyword(stmt) === "EXPLAIN") {
    return /\bANALYZE\b/i.test(stmt) ? null : stmt;
  }

  if (!isExplainable(stmt)) return null;

  switch (kind) {
    case "mysql":
      return isAtLeast(serverVersion, 8, 0, 18) ? `EXPLAIN FORMAT=TREE ${stmt}` : `EXPLAIN ${stmt}`;
    case "mariadb":
      return `EXPLAIN ${stmt}`;
    case "postgres":
      return `EXPLAIN ${stmt}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN ${stmt}`;
    case "clickhouse":
      return `EXPLAIN indexes = 1 ${stmt}`;
    case "mssql":
    case "redis":
    case "valkey":
      return null;
    default:
      return null;
  }
}

function cellText(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function padCell(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function renderTable(columns: ColumnMeta[], rows: string[][]): string[] {
  const headers = columns.map((c) => c.name);
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (cell.length > widths[i]) widths[i] = cell.length;
    });
  }
  const renderRow = (cells: string[]) =>
    cells
      .map((cell, i) => padCell(cell, widths[i]))
      .join("  ")
      .trimEnd();
  return [renderRow(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(renderRow)];
}

/**
 * Renders a `StatementResult` (typically an EXPLAIN result) as plain text for a chat prompt: a
 * failed statement becomes a one-line error note, a single-column result (Postgres text plans,
 * MySQL `FORMAT=TREE`) is just its cell values joined by newlines, and a multi-column result
 * (SQLite `EXPLAIN QUERY PLAN`, ClickHouse `EXPLAIN`) becomes an aligned plain-text table.
 */
export function formatResultAsText(
  result: StatementResult,
  { maxRows = 200, maxChars = 20000 }: { maxRows?: number; maxChars?: number } = {},
): string {
  if (result.kind === "error") return `EXPLAIN failed: ${result.error ?? "unknown error"}`;

  const totalRows = result.rows.length;
  const shownRows = Math.min(totalRows, Math.max(0, maxRows));
  const rows = result.rows.slice(0, shownRows);

  const lines =
    result.columns.length === 1
      ? rows.map((row) => cellText(row[0]))
      : renderTable(
          result.columns,
          rows.map((row) => row.map(cellText)),
        );

  let text = lines.join("\n");
  if (totalRows > shownRows) {
    text += `\n… (${totalRows - shownRows} more rows)`;
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n… (truncated)`;
  }
  return text;
}
