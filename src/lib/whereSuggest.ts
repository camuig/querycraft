/** Подсказки при вводе условия WHERE: имена колонок + базовые ключевые слова SQL. */

export interface WhereSuggestion {
  /** Текст подстановки. */
  text: string;
  kind: "column" | "keyword";
}

export interface WhereSuggestResult {
  items: WhereSuggestion[];
  /** Границы заменяемого слова в исходной строке. */
  wordStart: number;
  wordEnd: number;
}

const KEYWORDS = ["AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL", "LIKE", "BETWEEN", "NULL", "TRUE", "FALSE"];

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Находит идентификатор, в котором стоит каретка (буквы, цифры, `_`, `$`). */
export function wordAtCaret(text: string, caret: number): { start: number; end: number; word: string } {
  const pos = Math.max(0, Math.min(caret, text.length));
  let start = pos;
  while (start > 0 && IDENT_CHAR.test(text[start - 1])) start--;
  let end = pos;
  while (end < text.length && IDENT_CHAR.test(text[end])) end++;
  return { start, end, word: text.slice(start, pos) };
}

/**
 * Возвращает подсказки для текущего слова перед кареткой. Регистр не учитывается;
 * колонки идут первыми, затем ключевые слова. Пустой префикс — подсказок нет.
 */
export function suggestWhere(text: string, caret: number, columns: readonly string[], limit = 12): WhereSuggestResult {
  const { start, end, word } = wordAtCaret(text, caret);
  if (!word) return { items: [], wordStart: start, wordEnd: end };

  const prefix = word.toLowerCase();
  const matches = (candidate: string) => candidate.toLowerCase().startsWith(prefix) && candidate !== word;

  const items: WhereSuggestion[] = [];
  for (const c of columns) {
    if (matches(c)) items.push({ text: c, kind: "column" });
  }
  for (const k of KEYWORDS) {
    if (matches(k)) items.push({ text: k, kind: "keyword" });
  }
  return { items: items.slice(0, limit), wordStart: start, wordEnd: end };
}

/** Заменяет слово [wordStart, wordEnd) на подсказку; возвращает новый текст и позицию каретки. */
export function applySuggestion(text: string, wordStart: number, wordEnd: number, replacement: string): { text: string; caret: number } {
  const next = text.slice(0, wordStart) + replacement + text.slice(wordEnd);
  return { text: next, caret: wordStart + replacement.length };
}
