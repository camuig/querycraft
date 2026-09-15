// Parses clipboard text into a table of values (like pasting in DataGrip):
// rows split on newlines, columns split on tab, semicolon, comma or "|".
import type { CellValue } from "../api/types";

const DELIMITERS = ["\t", ";", ",", "|"] as const;

export type Delimiter = (typeof DELIMITERS)[number];

/** Detects the column delimiter: the first candidate found in the first non-empty line. */
export function detectDelimiter(lines: string[]): Delimiter | null {
  const sample = lines.find((l) => l.trim().length > 0) ?? "";
  for (const d of DELIMITERS) {
    if (sample.includes(d)) return d;
  }
  return null;
}

/** Splits a line by delimiter, honoring "..." quotes (CSV-style, "" is an escaped quote). */
export function splitLine(line: string, delimiter: Delimiter): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"' && cur.length === 0) {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Cell text value -> CellValue: empty string, NULL and <null> are treated as SQL NULL. */
export function toCellValue(raw: string): CellValue {
  const t = raw.trim();
  if (t === "" || t.toUpperCase() === "NULL" || t === "<null>") return null;
  return raw;
}

/**
 * Parses clipboard text into a matrix of values. Trailing empty lines are dropped;
 * empty lines in the middle become rows with a single NULL.
 */
export function parseClipboardTable(text: string): CellValue[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return [];
  const delimiter = detectDelimiter(lines);
  return lines.map((line) => {
    const cells = delimiter ? splitLine(line, delimiter) : [line];
    return cells.map(toCellValue);
  });
}

/**
 * Expands the pasted matrix to fill the selected range (like DataGrip): a single value
 * fills every cell, a single row repeats down the rows, a single column repeats across columns.
 * If the range is 1x1 or the matrix is larger than the range, it is returned as is.
 */
export function expandToRange(values: CellValue[][], rangeRows: number, rangeCols: number): CellValue[][] {
  if (values.length === 0) return values;
  const vRows = values.length;
  const vCols = Math.max(...values.map((r) => r.length));
  if (rangeRows <= 1 && rangeCols <= 1) return values;
  if (vRows > rangeRows || vCols > rangeCols) return values;
  const rows = rangeRows % vRows === 0 ? rangeRows : vRows;
  const cols = rangeCols % vCols === 0 ? rangeCols : vCols;
  const out: CellValue[][] = [];
  for (let i = 0; i < rows; i++) {
    const src = values[i % vRows];
    const line: CellValue[] = [];
    for (let j = 0; j < cols; j++) line.push(src[j % vCols] ?? null);
    out.push(line);
  }
  return out;
}
