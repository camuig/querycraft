// Helpers for building SQL: escaping identifiers/literals and building SELECT.

import type { CellValue, DbKind } from "../api/types";
import { dialectFor } from "./dialect";

/**
 * Wraps a name in the engine's identifier quote character, doubling it inside the name.
 * Engines with `dottedIdentifier` (SQL Server) split the name on the LAST dot and quote each
 * part separately, so `dbo.Orders` becomes `"dbo"."Orders"` — the documented assumption is that
 * a table name itself never contains a dot, only the schema.table separator does. A name
 * without a dot quotes as a single identifier either way.
 */
export function quoteIdent(name: string, kind: DbKind): string {
  const q = dialectFor(kind).identifierQuote;
  const quotePart = (part: string) => `${q}${part.replace(new RegExp(q, "g"), q + q)}${q}`;

  if (dialectFor(kind).dottedIdentifier) {
    const dotIdx = name.lastIndexOf(".");
    if (dotIdx >= 0) {
      return `${quotePart(name.slice(0, dotIdx))}.${quotePart(name.slice(dotIdx + 1))}`;
    }
  }
  return quotePart(name);
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

/**
 * Builds SELECT * FROM ... [WHERE ...] [ORDER BY ...] and a dialect-aware row limit:
 * a trailing `LIMIT n [OFFSET m]` for most engines, or SQL Server's
 * `OFFSET m ROWS FETCH NEXT n ROWS ONLY` (which requires an ORDER BY — when none was
 * requested but a row limit was, falls back to `ORDER BY (SELECT NULL)`).
 */
export function buildSelect(opts: BuildSelectOptions): string {
  let sql = `SELECT * FROM ${qualify(opts.database, opts.table, opts.kind)}`;

  const where = opts.where?.trim();
  if (where) {
    sql += ` WHERE (${where})`;
  }

  let orderByClause = "";
  if (opts.orderBy && opts.orderBy.length > 0) {
    const parts = opts.orderBy.map((o) => `${quoteIdent(o.column, opts.kind)} ${o.dir.toUpperCase()}`);
    orderByClause = ` ORDER BY ${parts.join(", ")}`;
  }

  const hasLimit = opts.limit !== undefined && opts.limit > 0;

  if (dialectFor(opts.kind).rowLimit === "fetch") {
    const offset = opts.offset ?? 0;
    const needsPaging = hasLimit || offset > 0;
    sql += needsPaging && !orderByClause ? " ORDER BY (SELECT NULL)" : orderByClause;
    if (needsPaging) {
      sql += ` OFFSET ${offset} ROWS`;
      if (hasLimit) sql += ` FETCH NEXT ${opts.limit} ROWS ONLY`;
    }
    return sql;
  }

  sql += orderByClause;
  if (hasLimit) sql += ` LIMIT ${opts.limit}`;
  if (opts.offset !== undefined && opts.offset > 0) sql += ` OFFSET ${opts.offset}`;

  return sql;
}
