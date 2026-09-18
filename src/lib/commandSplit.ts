// Splits Redis/Valkey console text into commands: one per non-blank, non-`#`-comment line.
// The counterpart of sqlSplit.ts for the "redis" query language.

import type { Statement } from "./sqlSplit";

export type { Statement };

/** True for a line that contributes nothing to execution: blank, or a `#` comment (optionally indented). */
function isSkippedLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/** Splits text into one Statement per non-blank, non-comment line, trimmed, with source offsets. */
export function splitCommands(text: string): Statement[] {
  const result: Statement[] = [];
  let offset = 0;

  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the '\n' consumed by split (absent on the last line, harmless)

    if (!isSkippedLine(line)) {
      const leadingWs = line.length - line.trimStart().length;
      const trailingWs = line.length - line.trimEnd().length;
      result.push({
        sql: line.trim(),
        from: lineStart + leadingWs,
        to: lineStart + line.length - trailingWs,
      });
    }
  }

  return result;
}

/** The command on the cursor's line, or null when that line is blank/a comment. */
export function commandAtCursor(text: string, pos: number): Statement | null {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = text.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);

  if (isSkippedLine(line)) return null;

  const leadingWs = line.length - line.trimStart().length;
  const trailingWs = line.length - line.trimEnd().length;
  return {
    sql: line.trim(),
    from: lineStart + leadingWs,
    to: lineStart + line.length - trailingWs,
  };
}
