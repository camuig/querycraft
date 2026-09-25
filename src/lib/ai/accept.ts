// Pure logic for turning an accepted AI answer into a document edit: which range of the console's
// text to replace or where to insert, and what selection to leave behind. Kept separate from
// useAiAssist.ts (which owns the EditorView / state machine) so it can be unit-tested without a real
// editor.

export interface ReplaceRangeEdit {
  from: number;
  to: number;
  insert: string;
  /** Selection to leave in the document after applying the edit, as absolute offsets. */
  selectionFrom: number;
  selectionTo: number;
}

/** "Edit selection" accept: replaces the exact remembered selection range with the accepted SQL. */
export function acceptEditSelection(from: number, to: number, sql: string): ReplaceRangeEdit {
  return { from, to, insert: sql, selectionFrom: from, selectionTo: from + sql.length };
}

/**
 * "Generate" accept with no selection, and the fallback for a "fix" accept whose original statement
 * can no longer be found: inserts at `pos`, starting a new line first when the current line is not
 * blank (so the new statement is not glued onto existing text), and selects the inserted SQL.
 */
export function insertAtCursor(doc: string, pos: number, sql: string): ReplaceRangeEdit {
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const nextNewline = doc.indexOf("\n", pos);
  const lineEnd = nextNewline === -1 ? doc.length : nextNewline;
  const line = doc.slice(lineStart, lineEnd);
  const prefix = line.trim().length > 0 ? "\n" : "";
  const selectionFrom = pos + prefix.length;
  return { from: pos, to: pos, insert: prefix + sql, selectionFrom, selectionTo: selectionFrom + sql.length };
}

/**
 * "Fix error" accept: replaces the failing statement in the current document. Searches for
 * `originalSql` (the statement text sent to the model) verbatim; when it appears more than once, the
 * occurrence whose start is closest to `anchorPos` (the cursor position remembered when the bar
 * opened) wins. Falls back to `insertAtCursor` when the statement can no longer be found — the user
 * may have edited or run something else in the console since the error happened.
 */
export function acceptFix(doc: string, originalSql: string, anchorPos: number, sql: string): ReplaceRangeEdit {
  const needle = originalSql.trim();
  if (!needle) return insertAtCursor(doc, anchorPos, sql);

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let from = doc.indexOf(needle);
  while (from !== -1) {
    const distance = Math.abs(from - anchorPos);
    if (distance < bestDistance) {
      best = from;
      bestDistance = distance;
    }
    from = doc.indexOf(needle, from + 1);
  }

  if (best === -1) return insertAtCursor(doc, anchorPos, sql);

  // The statement text a failed result carries (`StatementResult.sql`) is split on ";" and so never
  // includes the terminator, even though the document does. Swallow one immediately-following ";" so
  // it is not left stranded right after the replacement.
  let to = best + needle.length;
  if (!needle.endsWith(";") && doc[to] === ";") to += 1;

  return { from: best, to, insert: sql, selectionFrom: best, selectionTo: best + sql.length };
}
