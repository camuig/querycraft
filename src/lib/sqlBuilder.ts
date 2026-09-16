// Helpers for building SQL: escaping identifiers/literals and building SELECT.

import type { CellValue, DbKind } from "../api/types";
import { dialectFor } from "./dialect";

/** Wraps a name in the engine's identifier quote character, doubling it inside the name. */
export function quoteIdent(name: string, kind: DbKind): string {
  const q = dialectFor(kind).identifierQuote;
  return `${q}${name.replace(new RegExp(q, "g"), q + q)}${q}`;
}

/** "`db`.`table`" (or `"db"."table"` for double-quoting engines), or just the table when db === null. */
export function qualify(db: string | null, table: string, kind: DbKind): string {
  return db ? `${quoteIdent(db, kind)}.${quoteIdent(table, kind)}` : quoteIdent(table, kind);
}

/**
 * Converts a CellValue to a SQL literal.
 * null -> NULL; number -> as is; boolean -> TRUE/FALSE for PostgreSQL, 1/0 otherwise;
 * string -> single-quoted. Engines with backslash escapes (MySQL, MariaDB, ClickHouse) escape
 * special characters with a backslash; the rest (PostgreSQL, SQLite) only double single quotes.
 */
export function sqlLiteral(v: CellValue, kind: DbKind): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") {
    if (kind === "postgres") return v ? "TRUE" : "FALSE";
    return v ? "1" : "0";
  }

  if (!dialectFor(kind).backslashEscapes) {
    return `'${v.replace(/'/g, "''")}'`;
  }

  const escaped = v
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "\\0")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Ctrl-Z must be escaped in MySQL string literals
    .replace(/\x1a/g, "\\Z");
  return `'${escaped}'`;
}

export interface OrderBySpec {
  column: string;
  dir: "asc" | "desc";
}

export interface BuildSelectOptions {
  database: string | null;
  table: string;
  kind: DbKind;
  /** Arbitrary WHERE condition without the WHERE keyword; can be empty/null. */
  where?: string | null;
  orderBy?: OrderBySpec[];
  limit?: number;
  offset?: number;
}

/** Builds SELECT * FROM ... [WHERE ...] [ORDER BY ...] [LIMIT ...] [OFFSET ...]. */
export function buildSelect(opts: BuildSelectOptions): string {
  let sql = `SELECT * FROM ${qualify(opts.database, opts.table, opts.kind)}`;

  const where = opts.where?.trim();
  if (where) {
    sql += ` WHERE (${where})`;
  }

  if (opts.orderBy && opts.orderBy.length > 0) {
    const parts = opts.orderBy.map((o) => `${quoteIdent(o.column, opts.kind)} ${o.dir.toUpperCase()}`);
    sql += ` ORDER BY ${parts.join(", ")}`;
  }

  if (opts.limit !== undefined && opts.limit > 0) {
    sql += ` LIMIT ${opts.limit}`;
  }
  if (opts.offset !== undefined && opts.offset > 0) {
    sql += ` OFFSET ${opts.offset}`;
  }

  return sql;
}
