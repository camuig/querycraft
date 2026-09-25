// Pure helpers for inline completion ("ghost text") in the SQL editor: whether the current cursor
// position is worth asking the model about, the prompts sent to it, and cleanup of its reply into
// text that is safe to insert verbatim at the cursor. No store or IPC access here — the CodeMirror
// extension (`src/components/editor/inlineCompletion.ts`) and `ConsoleTab` own the request/response
// plumbing and call into this module.

/** What `buildInlineSystemPrompt` needs to know about the connection. */
export interface InlineContext {
  dialectLabel: string;
  serverVersion?: string | null;
  database?: string | null;
  /** Compact schema DDL from `gatherSchemaContext`; absent/empty when no schema was shared. */
  schema?: string;
}

const PREFIX_LIMIT = 4000;
const SUFFIX_LIMIT = 1000;
const MAX_LINES = 8;
/** Longest echoed overlap we bother looking for when stripping a repeated prefix/suffix. */
const MAX_OVERLAP = 200;

type TailState = "normal" | "squote" | "dquote" | "backtick" | "linecomment" | "blockcomment";

/**
 * Scans `text` from the start and returns the lexical state at its end: whether it finishes inside
 * a string literal or a comment. Good enough for the trigger heuristic below — it does not need to
 * be a full SQL tokenizer, only to avoid firing a completion request mid-string or mid-comment.
 */
function tailState(text: string): TailState {
  let state: TailState = "normal";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (state === "normal") {
      if (c === "-" && text[i + 1] === "-") {
        state = "linecomment";
        i += 2;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        state = "blockcomment";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        state = c === "'" ? "squote" : c === '"' ? "dquote" : "backtick";
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (state === "linecomment") {
      if (c === "\n") state = "normal";
      i++;
      continue;
    }
    if (state === "blockcomment") {
      if (c === "*" && text[i + 1] === "/") {
        state = "normal";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // Inside a string literal: squote/dquote/backtick.
    const quote = state === "squote" ? "'" : state === "dquote" ? '"' : "`";
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (text[i + 1] === quote) {
        i += 2; // doubled quote escapes itself
        continue;
      }
      state = "normal";
      i++;
      continue;
    }
    i++;
  }
  return state;
}

function nonSpaceCount(text: string): number {
  return text.replace(/\s/g, "").length;
}

function currentLinePrefix(prefix: string): string {
  const nl = prefix.lastIndexOf("\n");
  return nl === -1 ? prefix : prefix.slice(nl + 1);
}

/**
 * The prefix's current statement, roughly: everything back to the nearest unquoted `;` (or the
 * start of the text). Good enough for the trigger heuristic; the actual request sends the full
 * capped prefix regardless.
 */
function currentStatementPrefix(prefix: string): string {
  let state: TailState = "normal";
  let lastBoundary = 0;
  let i = 0;
  while (i < prefix.length) {
    const c = prefix[i];
    if (state === "normal") {
      if (c === ";") {
        lastBoundary = i + 1;
        i++;
        continue;
      }
      if (c === "-" && prefix[i + 1] === "-") {
        state = "linecomment";
        i += 2;
        continue;
      }
      if (c === "/" && prefix[i + 1] === "*") {
        state = "blockcomment";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        state = c === "'" ? "squote" : c === '"' ? "dquote" : "backtick";
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (state === "linecomment") {
      if (c === "\n") state = "normal";
      i++;
      continue;
    }
    if (state === "blockcomment") {
      if (c === "*" && prefix[i + 1] === "/") {
        state = "normal";
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    const quote = state === "squote" ? "'" : state === "dquote" ? '"' : "`";
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (prefix[i + 1] === quote) {
        i += 2;
        continue;
      }
      state = "normal";
      i++;
      continue;
    }
    i++;
  }
  return prefix.slice(lastBoundary);
}

/** Whether the character right after the cursor allows an inline suggestion to be requested. */
function cursorPositionOk(suffix: string): boolean {
  if (suffix.length === 0) return true; // end of the document
  const c = suffix[0];
  return c === "\n" || c === " " || c === "\t" || c === ")" || c === "," || c === ";";
}

/**
 * Whether the cursor is a good place to trigger an inline completion request: at least 3 non-space
 * characters typed in the current statement or line, the cursor sits at the end of a line or right
 * before whitespace/`)`/`,`/`;`, and it is not in the middle of an unterminated string literal or a
 * `--`/`/* ... *\/` comment (the model would just be asked to continue quoted or commented-out text).
 */
export function shouldTriggerInline(prefix: string, suffix: string): boolean {
  if (tailState(prefix) !== "normal") return false;
  if (!cursorPositionOk(suffix)) return false;
  return nonSpaceCount(currentLinePrefix(prefix)) >= 3 || nonSpaceCount(currentStatementPrefix(prefix)) >= 3;
}

/**
 * System prompt for the inline-completion request. Deterministic for the same context (prompt
 * caching), mirroring `buildSystemPrompt` in `prompts.ts` but tuned for a single short completion
 * instead of a full statement with commentary.
 */
export function buildInlineSystemPrompt(ctx: InlineContext): string {
  const engine = ctx.serverVersion ? `${ctx.dialectLabel} ${ctx.serverVersion}` : ctx.dialectLabel;

  const rules = [
    `You are a SQL autocomplete engine for ${engine}.`,
    "Reply with ONLY the exact text to insert at the cursor — no code fences, no explanations, no repetition of text before or after the cursor.",
    "Complete the current statement or clause; at most a few lines.",
    "If nothing sensible can be added, reply with an empty message.",
  ].join("\n");

  const context = [`Engine: ${engine}`, `Current database: ${ctx.database ?? "(none selected)"}`].join("\n");

  const schemaBlock = ctx.schema ? `Schema:\n${ctx.schema}` : "No schema metadata was shared for this connection.";

  return [rules, context, schemaBlock].join("\n\n");
}

/**
 * User message for the inline-completion request: the text around the cursor, capped and wrapped in
 * a fenced block with an explicit `<CURSOR>` marker so the model cannot mistake where its reply goes.
 */
export function buildInlineUserMessage(prefix: string, suffix: string): string {
  const truncatedPrefix = prefix.slice(-PREFIX_LIMIT);
  const truncatedSuffix = suffix.slice(0, SUFFIX_LIMIT);
  return [
    "Complete the SQL at the cursor position marked below. Reply with only the text to insert there.",
    "",
    "```sql",
    `${truncatedPrefix}<CURSOR>${truncatedSuffix}`,
    "```",
  ].join("\n");
}

function stripCodeFences(text: string): string {
  const outer = text.trim();
  const closed = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(outer);
  if (closed) return closed[1];
  const openOnly = /^```[^\n]*\n([\s\S]*)$/.exec(outer);
  if (openOnly) return openOnly[1];
  return text;
}

function stripCursorEcho(text: string): string {
  const trimmedStart = text.replace(/^\s+/, "");
  return trimmedStart.startsWith("<CURSOR>") ? trimmedStart.slice("<CURSOR>".length) : text;
}

/** Removes the longest echoed overlap between the end of `before` and the start of `text`. */
function stripLeadingOverlap(text: string, before: string): string {
  const max = Math.min(before.length, text.length, MAX_OVERLAP);
  for (let len = max; len > 0; len--) {
    if (before.slice(before.length - len) === text.slice(0, len)) {
      return text.slice(len);
    }
  }
  return text;
}

/** Removes the longest echoed overlap between the start of `after` and the end of `text`. */
function stripTrailingOverlap(text: string, after: string): string {
  const max = Math.min(after.length, text.length, MAX_OVERLAP);
  for (let len = max; len > 0; len--) {
    if (after.slice(0, len) === text.slice(text.length - len)) {
      return text.slice(0, text.length - len);
    }
  }
  return text;
}

/** Avoids a double space/tab when the prefix already ends right where the completion would begin. */
function normalizeLeadingWhitespace(text: string, prefix: string): string {
  if (text.length === 0 || !/[ \t]$/.test(prefix)) return text;
  return text.replace(/^[ \t]+/, "");
}

function capLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(0, maxLines).join("\n");
}

/**
 * Turns the model's raw reply into text safe to insert verbatim at the cursor: strips a code fence
 * (models tend to add one despite being told not to), an echoed `<CURSOR>` marker, and any repetition
 * of text already on either side of the cursor; caps the result to a few lines; returns "" for a
 * reply that ends up empty or whitespace-only (nothing to suggest).
 */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = stripCodeFences(raw);
  text = stripCursorEcho(text);
  text = stripLeadingOverlap(text, prefix);
  text = stripTrailingOverlap(text, suffix);
  text = normalizeLeadingWhitespace(text, prefix);
  text = text.replace(/\s+$/, "");
  text = capLines(text, MAX_LINES);
  return /\S/.test(text) ? text : "";
}
