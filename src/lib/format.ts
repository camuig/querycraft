// Cell formatting and grid result export to CSV/TSV/JSON/SQL.

import type { CellValue, ColumnMeta } from "../api/types";
import { qualify, quoteIdent, sqlLiteral } from "./sqlBuilder";

const MAX_CELL_LENGTH = 1000;

/**
 * Formats a cell value for display in the grid.
 * null -> "" (the grid marks null itself via a CSS class, so we don't write "<null>" here).
 * number -> String(v).
 * boolean -> String(v) ("true"/"false").
 * string -> the string itself; if longer than 1000 characters, truncated to 1000 + "…".
 */
export function formatCell(v: CellValue, _meta?: ColumnMeta): string {
  if (v === null) return "";
  if (typeof v === "string") {
    return v.length > MAX_CELL_LENGTH ? `${v.slice(0, MAX_CELL_LENGTH)}…` : v;
  }
  return String(v);
}

/** Escapes a value for a CSV field: quoted when it contains `,`, `"`, `\n`, `\r`; null -> empty field. */
function csvField(v: CellValue): string {
  if (v === null) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * CSV: the first row is column headers, delimiter `,`, values are quoted
 * when they contain `,`/`"`/newlines (inner quotes are doubled), null -> "",
 * rows are separated by `\n`.
 */
export function toCsv(columns: ColumnMeta[], rows: CellValue[][]): string {
  const header = columns.map((c) => csvField(c.name)).join(",");
  const lines = rows.map((row) => row.map((v) => csvField(v)).join(","));
  return [header, ...lines].join("\n");
}

/** Escapes a value for a TSV field: tabs and newlines are replaced with a space; null -> "". */
function tsvField(v: CellValue): string {
  if (v === null) return "";
  const s = typeof v === "string" ? v : String(v);
  return s.replace(/\t/g, " ").replace(/\r\n|\r|\n/g, " ");
}

/**
 * TSV: the first row is headers, delimiter is a tab. Tabs and newlines
 * inside values are replaced with a space (\t -> " ", \n/\r -> " "), null -> "".
 */
export function toTsv(columns: ColumnMeta[], rows: CellValue[][]): string {
  const header = columns.map((c) => tsvField(c.name)).join("\t");
  const lines = rows.map((row) => row.map((v) => tsvField(v)).join("\t"));
  return [header, ...lines].join("\n");
}

export type CopyFormat = "tsv" | "csv";

/** Text for the clipboard: a range of values in TSV or CSV, optionally with headers. */
export function rowsToClipboardText(
  columns: ColumnMeta[],
  rows: CellValue[][],
  format: CopyFormat,
  withHeaders: boolean,
): string {
  const field = format === "csv" ? csvField : tsvField;
  const sep = format === "csv" ? "," : "\t";
  const lines = rows.map((row) => row.map((v) => field(v)).join(sep));
  if (withHeaders) lines.unshift(columns.map((c) => field(c.name)).join(sep));
  return lines.join("\n");
}

/** JSON.stringify of an array of {colName: value} objects, indented with 2 spaces. */
export function toJson(columns: ColumnMeta[], rows: CellValue[][]): string {
  const arr = rows.map((row) => {
    const obj: Record<string, CellValue> = {};
    columns.forEach((c, i) => {
      obj[c.name] = row[i] ?? null;
    });
    return obj;
  });
  return JSON.stringify(arr, null, 2);
}

/** Multi-line dump: one INSERT INTO ... VALUES (...); per line. */
export function toSqlInserts(
  database: string | null,
  table: string,
  columns: ColumnMeta[],
  rows: CellValue[][],
): string {
  const target = qualify(database, table);
  const colList = columns.map((c) => quoteIdent(c.name)).join(", ");
  const lines = rows.map((row) => {
    const values = row.map((v) => sqlLiteral(v)).join(", ");
    return `INSERT INTO ${target} (${colList}) VALUES (${values});`;
  });
  return lines.join("\n");
}
