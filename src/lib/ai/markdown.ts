// A small, safe Markdown parser for LLM chat answers: turns text into an AST (`MdBlock[]`) that a
// React renderer can walk without ever needing `dangerouslySetInnerHTML`. Deliberately not a full
// CommonMark/GFM implementation — just enough of it (headings, paragraphs, fenced code, lists,
// tables, blockquotes, rules, and the common inline spans) to render a typical model answer well,
// while never throwing on malformed or adversarial input: an assistant message is untrusted text
// streamed in real time, and a parser bug must never break the chat UI.

export type MdInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "link"; href: string; children: MdInline[] };

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { type: "paragraph"; children: MdInline[] }
  | { type: "code"; lang: string; text: string; closed: boolean }
  | { type: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { type: "table"; header: MdInline[][]; align: ("left" | "center" | "right" | null)[]; rows: MdInline[][][] }
  | { type: "blockquote"; children: MdBlock[] }
  | { type: "hr" };

/** Caps recursive nesting (blockquote-in-list-in-blockquote...) so pathological input can't blow the stack. */
const MAX_BLOCK_DEPTH = 6;

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

function leadingSpaces(line: string): number {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

function matchHr(line: string): boolean {
  return (
    /^ {0,3}(-[ \t]*){3,}$/.test(line) || /^ {0,3}(\*[ \t]*){3,}$/.test(line) || /^ {0,3}(_[ \t]*){3,}$/.test(line)
  );
}

function matchHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
  if (!match) return null;
  const text = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "");
  return { level: match[1].length as 1 | 2 | 3 | 4 | 5 | 6, text };
}

function matchFenceOpen(line: string): { indent: number; fenceChar: string; fenceLen: number; lang: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1];
  const info = match[2].trim();
  return {
    indent: line.length - line.trimStart().length,
    fenceChar: fence[0],
    fenceLen: fence.length,
    lang: info.split(/\s+/)[0] ?? "",
  };
}

function matchFenceClose(line: string, fenceChar: string, fenceLen: number): boolean {
  const pattern = fenceChar === "`" ? /^ {0,3}(`{3,})[ \t]*$/ : /^ {0,3}(~{3,})[ \t]*$/;
  const match = pattern.exec(line);
  return !!match && match[1].length >= fenceLen;
}

function stripIndent(line: string, indent: number): string {
  let i = 0;
  while (i < indent && line[i] === " ") i++;
  return line.slice(i);
}

function matchBlockquote(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

function stripBlockquote(line: string): string | null {
  const match = /^ {0,3}>[ \t]?(.*)$/.exec(line);
  return match ? match[1] : null;
}

interface ListItemMatch {
  indent: number;
  ordered: boolean;
  start: number;
  contentIndent: number;
  text: string;
}

function matchListItem(line: string): ListItemMatch | null {
  const withText = /^( {0,3})([-*+]|(\d{1,9})[.)])([ \t]+)(.*)$/.exec(line);
  if (withText) {
    const [, indentStr, marker, digits, gap, text] = withText;
    return {
      indent: indentStr.length,
      ordered: digits !== undefined,
      start: digits !== undefined ? Number(digits) : 1,
      contentIndent: indentStr.length + marker.length + gap.length,
      text,
    };
  }
  const empty = /^( {0,3})([-*+]|(\d{1,9})[.)])[ \t]*$/.exec(line);
  if (empty) {
    const [, indentStr, marker, digits] = empty;
    return {
      indent: indentStr.length,
      ordered: digits !== undefined,
      start: digits !== undefined ? Number(digits) : 1,
      contentIndent: indentStr.length + marker.length + 1,
      text: "",
    };
  }
  return null;
}

/** Splits a `| a | b |`-style row into trimmed cell strings, honoring `\|` as an escaped pipe. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (s[i] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += s[i];
  }
  cells.push(current.trim());
  return cells;
}

function parseAlign(cell: string): "left" | "center" | "right" | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function tryParseTable(lines: string[], i: number): { block: MdBlock; next: number } | null {
  const headerLine = lines[i];
  const delimLine = lines[i + 1];
  if (delimLine === undefined || !headerLine.trim()) return null;
  if (!headerLine.includes("|") && !delimLine.includes("|")) return null;

  const delimCells = splitTableRow(delimLine);
  if (delimCells.length === 0 || !delimCells.every((c) => /^:?-+:?$/.test(c))) return null;

  const header = splitTableRow(headerLine).map(parseInline);
  const align = delimCells.map(parseAlign);

  const rows: MdInline[][][] = [];
  let j = i + 2;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (isBlank(line) || matchHeading(line) || matchHr(line) || matchFenceOpen(line) || matchBlockquote(line)) break;
    rows.push(splitTableRow(line).map(parseInline));
  }

  return { block: { type: "table", header, align, rows }, next: j };
}

function parseList(lines: string[], start: number, depth: number): { block: MdBlock; next: number } {
  const first = matchListItem(lines[start]);
  if (!first) {
    // Unreachable given the caller only invokes this after a successful matchListItem — kept as a
    // defensive fallback so this function can never throw.
    return { block: { type: "list", ordered: false, start: 1, items: [[]] }, next: start + 1 };
  }
  const { ordered, indent: baseIndent } = first;
  const items: MdBlock[][] = [];
  let i = start;
  let listStart = first.start;

  while (i < lines.length) {
    const item = matchListItem(lines[i]);
    if (!item || item.ordered !== ordered || item.indent !== baseIndent) break;
    if (items.length === 0) listStart = item.start;

    const itemLines: string[] = [item.text];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (isBlank(line)) {
        itemLines.push("");
        continue;
      }
      if (leadingSpaces(line) >= item.contentIndent) {
        itemLines.push(line.slice(item.contentIndent));
        continue;
      }
      break;
    }
    while (itemLines.length > 0 && itemLines[itemLines.length - 1] === "") itemLines.pop();

    items.push(parseBlocks(itemLines, depth + 1));
    i = j;
  }

  return { block: { type: "list", ordered, start: listStart, items }, next: i };
}

function parseBlocks(lines: string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  const n = lines.length;
  let i = 0;

  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = matchFenceOpen(line);
    if (fence) {
      const codeLines: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < n; j++) {
        if (matchFenceClose(lines[j], fence.fenceChar, fence.fenceLen)) {
          closed = true;
          j++;
          break;
        }
        codeLines.push(stripIndent(lines[j], fence.indent));
      }
      blocks.push({ type: "code", lang: fence.lang, text: codeLines.join("\n"), closed });
      i = j;
      continue;
    }

    if (matchHr(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, children: parseInline(heading.text) });
      i++;
      continue;
    }

    if (matchBlockquote(line) && depth < MAX_BLOCK_DEPTH) {
      const quoteLines: string[] = [];
      let j = i;
      for (; j < n; j++) {
        const stripped = stripBlockquote(lines[j]);
        if (stripped === null) break;
        quoteLines.push(stripped);
      }
      blocks.push({ type: "blockquote", children: parseBlocks(quoteLines, depth + 1) });
      i = j;
      continue;
    }

    const table = tryParseTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    if (matchListItem(line) && depth < MAX_BLOCK_DEPTH) {
      const { block, next } = parseList(lines, i, depth);
      blocks.push(block);
      i = next;
      continue;
    }

    const paraLines = [line];
    let j = i + 1;
    for (; j < n; j++) {
      const next = lines[j];
      if (isBlank(next)) break;
      if (matchFenceOpen(next) || matchHr(next) || matchHeading(next) || matchBlockquote(next) || matchListItem(next))
        break;
      paraLines.push(next);
    }
    blocks.push({ type: "paragraph", children: parseInline(paraLines.join("\n")) });
    i = j;
  }

  return blocks;
}

/** Parses a full Markdown document (or streamed-so-far prefix of one) into a block AST. Never throws. */
export function parseMarkdown(text: string): MdBlock[] {
  try {
    const lines = String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    return parseBlocks(lines, 0);
  } catch {
    return [];
  }
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

function matchLink(text: string, i: number): { text: string; href: string; next: number } | null {
  const rest = text.slice(i);
  const match = /^\[([^\]]*)\]\(([^)\s]*)(?:[ \t]+"[^"]*")?\)/.exec(rest);
  if (!match) return null;
  return { text: match[1], href: match[2], next: i + match[0].length };
}

/** Finds the index of the closing `**`/`__` for a strong span opened right before `start`. */
function findClosingStrong(text: string, start: number, delim: string): number {
  let idx = text.indexOf(delim, start);
  while (idx !== -1) {
    if (text[idx - 1] !== " ") return idx;
    idx = text.indexOf(delim, idx + 1);
  }
  return -1;
}

/** Finds the index of the closing `*`/`_` for an em span opened right before `start`. */
function findClosingEm(text: string, start: number, ch: string): number {
  for (let k = start; k < text.length; k++) {
    if (text[k] !== ch) continue;
    if (text[k + 1] === ch) {
      k++; // Part of a "**"/"__" run: skip the pair rather than treating it as our closer.
      continue;
    }
    if (text[k - 1] === " ") continue;
    if (ch === "_" && /[A-Za-z0-9]/.test(text[k + 1] ?? "")) continue;
    return k;
  }
  return -1;
}

function parseInlineImpl(text: string): MdInline[] {
  const nodes: MdInline[] = [];
  let buffer = "";
  let i = 0;
  const n = text.length;

  const flush = () => {
    if (buffer) {
      nodes.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  while (i < n) {
    const ch = text[i];

    if (ch === "`") {
      let runLen = 1;
      while (text[i + runLen] === "`") runLen++;
      const opening = "`".repeat(runLen);
      const closeIdx = text.indexOf(opening, i + runLen);
      if (closeIdx !== -1) {
        flush();
        let content = text.slice(i + runLen, closeIdx);
        if (content.startsWith(" ") && content.endsWith(" ") && content.trim().length > 0) {
          content = content.slice(1, -1);
        }
        nodes.push({ type: "code", text: content });
        i = closeIdx + runLen;
        continue;
      }
    }

    if (ch === "[") {
      const link = matchLink(text, i);
      if (link) {
        flush();
        const children = parseInlineImpl(link.text);
        if (SAFE_HREF.test(link.href)) {
          nodes.push({ type: "link", href: link.href, children });
        } else {
          nodes.push(...children);
        }
        i = link.next;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const delim = ch + ch;
      const nextChar = text[i + 2];
      if (nextChar && nextChar !== " ") {
        const end = findClosingStrong(text, i + 2, delim);
        if (end !== -1) {
          flush();
          nodes.push({ type: "strong", children: parseInlineImpl(text.slice(i + 2, end)) });
          i = end + 2;
          continue;
        }
      }
    }

    if (ch === "*" || ch === "_") {
      const prevChar = text[i - 1];
      const nextChar = text[i + 1];
      const leftFlankOk = ch === "*" || !prevChar || !/[A-Za-z0-9]/.test(prevChar);
      if (leftFlankOk && nextChar && nextChar !== " " && nextChar !== ch) {
        const end = findClosingEm(text, i + 1, ch);
        if (end !== -1) {
          flush();
          nodes.push({ type: "em", children: parseInlineImpl(text.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }

    buffer += ch;
    i++;
  }

  flush();
  return nodes;
}

/** Parses inline spans (code, strong, em, links) within a run of text. Never throws. */
export function parseInline(text: string): MdInline[] {
  try {
    return parseInlineImpl(String(text ?? ""));
  } catch {
    return [{ type: "text", text: String(text ?? "") }];
  }
}
