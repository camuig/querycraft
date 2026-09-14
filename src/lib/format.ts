// Форматирование ячеек и экспорт результатов грида в CSV/TSV/JSON/SQL.

import type { CellValue, ColumnMeta } from "../api/types";
import { quoteIdent, qualify, sqlLiteral } from "./sqlBuilder";

const MAX_CELL_LENGTH = 1000;

/**
 * Форматирует значение ячейки для отображения в гриде.
 * null -> "" (признак null грид показывает сам через CSS-класс, тут не пишем "<null>").
 * number -> String(v).
 * boolean -> String(v) ("true"/"false").
 * string -> сама строка; если длина > 1000 символов — обрезается до 1000 + "…".
 */
export function formatCell(v: CellValue, _meta?: ColumnMeta): string {
  if (v === null) return "";
  if (typeof v === "string") {
    return v.length > MAX_CELL_LENGTH ? v.slice(0, MAX_CELL_LENGTH) + "…" : v;
  }
  return String(v);
}

/** Экранирует значение для CSV-поля: кавычки при наличии `,`, `"`, `\n`, `\r`, null -> пустое поле. */
function csvField(v: CellValue): string {
  if (v === null) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * CSV: первая строка — заголовки колонок, разделитель `,`, значения в кавычках
 * при наличии `,`/`"`/переводов строк (кавычки внутри дублируются), null -> "",
 * строки разделены `\n`.
 */
export function toCsv(columns: ColumnMeta[], rows: CellValue[][]): string {
  const header = columns.map((c) => csvField(c.name)).join(",");
  const lines = rows.map((row) => row.map((v) => csvField(v)).join(","));
  return [header, ...lines].join("\n");
}

/** Экранирует значение для TSV-поля: табы и переводы строк заменяются на пробел, null -> "". */
function tsvField(v: CellValue): string {
  if (v === null) return "";
  const s = typeof v === "string" ? v : String(v);
  return s.replace(/\t/g, " ").replace(/\r\n|\r|\n/g, " ");
}

/**
 * TSV: первая строка — заголовки, разделитель — таб. Табы и переводы строк
 * внутри значений заменяются на пробел (\t -> " ", \n/\r -> " "), null -> "".
 */
export function toTsv(columns: ColumnMeta[], rows: CellValue[][]): string {
  const header = columns.map((c) => tsvField(c.name)).join("\t");
  const lines = rows.map((row) => row.map((v) => tsvField(v)).join("\t"));
  return [header, ...lines].join("\n");
}

/** JSON.stringify массива объектов {colName: value}, с отступом 2. */
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

/** Многострочный дамп: один INSERT INTO ... VALUES (...); на строку. */
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
