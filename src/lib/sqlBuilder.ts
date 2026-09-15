// Helpers for building SQL: escaping identifiers/literals and building SELECT.

import type { CellValue } from "../api/types";

/** Wraps a name in backticks, doubling internal backticks. */
export function quoteIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

/** "`db`.`table`", or just "`table`" if db === null. */
export function qualify(db: string | null, table: string): string {
  return db ? `${quoteIdent(db)}.${quoteIdent(table)}` : quoteIdent(table);
}

/**
 * Converts a CellValue to a SQL literal.
 * null -> NULL; number -> as is; boolean -> 1/0;
 * string -> single-quoted, with special characters escaped using a backslash.
 */
export function sqlLiteral(v: CellValue): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";

  const escaped = v
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "\\0")
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
  /** Arbitrary WHERE condition without the WHERE keyword; can be empty/null. */
  where?: string | null;
  orderBy?: OrderBySpec[];
  limit?: number;
  offset?: number;
}

/** Builds SELECT * FROM ... [WHERE ...] [ORDER BY ...] [LIMIT ...] [OFFSET ...]. */
export function buildSelect(opts: BuildSelectOptions): string {
  let sql = `SELECT * FROM ${qualify(opts.database, opts.table)}`;

  const where = opts.where?.trim();
  if (where) {
    sql += ` WHERE (${where})`;
  }

  if (opts.orderBy && opts.orderBy.length > 0) {
    const parts = opts.orderBy.map((o) => `${quoteIdent(o.column)} ${o.dir.toUpperCase()}`);
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
