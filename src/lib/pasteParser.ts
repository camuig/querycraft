// Разбор текста из буфера обмена в таблицу значений (как вставка в DataGrip):
// строки — по переносам, колонки — по табуляции, точке с запятой, запятой или «|».
import type { CellValue } from "../api/types";

const DELIMITERS = ["\t", ";", ",", "|"] as const;

export type Delimiter = (typeof DELIMITERS)[number];

/** Определяет разделитель колонок: первый из кандидатов, который встречается в первой непустой строке. */
export function detectDelimiter(lines: string[]): Delimiter | null {
  const sample = lines.find((l) => l.trim().length > 0) ?? "";
  for (const d of DELIMITERS) {
    if (sample.includes(d)) return d;
  }
  return null;
}

/** Разбивает строку по разделителю с учётом кавычек "..." (CSV-стиль, "" — экранированная кавычка). */
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

/** Текстовое значение ячейки → CellValue: пустая строка, NULL и <null> считаются SQL NULL. */
export function toCellValue(raw: string): CellValue {
  const t = raw.trim();
  if (t === "" || t.toUpperCase() === "NULL" || t === "<null>") return null;
  return raw;
}

/**
 * Разбирает текст буфера в матрицу значений. Пустые строки в конце отбрасываются,
 * пустые строки в середине становятся строками с одним NULL.
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
 * Растягивает вставляемую матрицу на выделенный диапазон (как DataGrip): одно значение
 * заполняет все ячейки, одна строка повторяется по строкам, одна колонка — по колонкам.
 * Если диапазон 1×1 или матрица больше диапазона — возвращается как есть.
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
