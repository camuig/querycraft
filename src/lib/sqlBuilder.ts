// Хелперы для построения SQL: экранирование идентификаторов/литералов и SELECT.

import type { CellValue } from "../api/types";

/** Оборачивает имя в обратные кавычки, удваивая внутренние `. */
export function quoteIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

/** "`db`.`table`" или просто "`table`", если db === null. */
export function qualify(db: string | null, table: string): string {
  return db ? `${quoteIdent(db)}.${quoteIdent(table)}` : quoteIdent(table);
}

/**
 * Преобразует CellValue в SQL-литерал.
 * null -> NULL; number -> как есть; boolean -> 1/0;
 * string -> в одинарных кавычках с экранированием спецсимволов бэкслешем.
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
  /** Произвольное WHERE-условие без слова WHERE, может быть пустым/null. */
  where?: string | null;
  orderBy?: OrderBySpec[];
  limit?: number;
  offset?: number;
}

/** Строит SELECT * FROM ... [WHERE ...] [ORDER BY ...] [LIMIT ...] [OFFSET ...]. */
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
