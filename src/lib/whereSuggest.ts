/** Suggestions while typing a WHERE condition: column names + basic SQL keywords. */

export interface WhereSuggestion {
  /** Replacement text. */
  text: string;
  kind: "column" | "keyword";
}

export interface WhereSuggestResult {
  items: WhereSuggestion[];
  /** Bounds of the word being replaced in the source string. */
  wordStart: number;
  wordEnd: number;
}

const KEYWORDS = ["AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL", "LIKE", "BETWEEN", "NULL", "TRUE", "FALSE"];

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Finds the identifier the caret is inside of (letters, digits, `_`, `$`). */
export function wordAtCaret(text: string, caret: number): { start: number; end: number; word: string } {
  const pos = Math.max(0, Math.min(caret, text.length));
  let start = pos;
  while (start > 0 && IDENT_CHAR.test(text[start - 1])) start--;
  let end = pos;
  while (end < text.length && IDENT_CHAR.test(text[end])) end++;
  return { start, end, word: text.slice(start, pos) };
}

/**
 * Returns suggestions for the current word before the caret. Case-insensitive;
 * columns come first, then keywords. Empty prefix means no suggestions.
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

/** Replaces the word [wordStart, wordEnd) with the suggestion; returns the new text and caret position. */
export function applySuggestion(
  text: string,
  wordStart: number,
  wordEnd: number,
  replacement: string,
): { text: string; caret: number } {
  const next = text.slice(0, wordStart) + replacement + text.slice(wordEnd);
  return { text: next, caret: wordStart + replacement.length };
}
