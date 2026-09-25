// System/user prompt builders for the assistant's features (Generate SQL, Fix error, Explain,
// Optimize, side chat) and the helpers that parse the model's reply back into a statement. Pure
// functions only.

import type { AiMessage } from "../../api/types";

export interface PromptContext {
  dialectLabel: string;
  queryLanguage: "sql" | "redis";
  serverVersion?: string | null;
  database?: string | null;
  /** Compact schema DDL from `buildSchemaContext`; absent/empty when no schema was shared. */
  schema?: string;
}

/**
 * The system prompt is kept stable and deterministic (it is prompt-cached): the same connection,
 * database and schema always produce the exact same text, so only the user message changes
 * between requests in a session.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const lang = ctx.queryLanguage === "redis" ? "redis" : "sql";
  const engine = ctx.serverVersion ? `${ctx.dialectLabel} ${ctx.serverVersion}` : ctx.dialectLabel;

  const rules = [
    `You are an expert ${ctx.dialectLabel} assistant inside a database client.`,
    `Reply with exactly one fenced code block (\`\`\`${lang}) containing only the statement(s) to run — no prose outside the code block.`,
    "Brief assumptions may go in comments inside the code block, never outside it.",
    `Target ${engine} syntax.`,
    ctx.schema
      ? "Use only the tables and columns listed in the schema below; never invent tables or columns that are not there."
      : "No schema was shared for this connection; do not invent specific table or column names.",
    "Never produce a destructive statement (DROP, TRUNCATE, or DELETE/UPDATE without a WHERE clause) unless the user explicitly asks for it.",
    "When editing existing SQL, keep the user's formatting style and letter case.",
  ].join("\n");

  const context = [`Engine: ${engine}`, `Current database: ${ctx.database ?? "(none selected)"}`].join("\n");

  const schemaBlock = ctx.schema ? `Schema:\n${ctx.schema}` : "No schema metadata was shared for this connection.";

  return [rules, context, schemaBlock].join("\n\n");
}

/**
 * System prompt for the side chat: same deterministic engine/database/schema context section as
 * `buildSystemPrompt`, but rules suited to a free-form conversation instead of a single SQL edit —
 * concise Markdown answers, replying in the user's language, and being explicit that the assistant
 * cannot run anything itself.
 */
export function buildChatSystemPrompt(ctx: PromptContext): string {
  const lang = ctx.queryLanguage === "redis" ? "redis" : "sql";
  const engine = ctx.serverVersion ? `${ctx.dialectLabel} ${ctx.serverVersion}` : ctx.dialectLabel;

  const rules = [
    `You are an expert ${ctx.dialectLabel} assistant inside a database client, chatting with a developer.`,
    "Answer concisely, formatted as Markdown.",
    "Reply in the language of the user's latest message.",
    `Put any SQL in fenced code blocks (\`\`\`${lang}) targeting ${engine} syntax.`,
    ctx.schema
      ? "Use only the tables and columns listed in the schema below; never invent tables or columns that are not there — say so when something you would need is missing."
      : "No schema was shared for this connection; do not invent specific table or column names — say so when you would need the schema to answer precisely.",
    "You cannot run queries yourself and must never claim that you did; suggest statements for the user to run instead.",
    "Warn clearly before suggesting any destructive statement (DROP, TRUNCATE, or DELETE/UPDATE without a WHERE clause).",
    "Prefer standard, index-friendly SQL.",
  ].join("\n");

  const context = [`Engine: ${engine}`, `Current database: ${ctx.database ?? "(none selected)"}`].join("\n");

  const schemaBlock = ctx.schema ? `Schema:\n${ctx.schema}` : "No schema metadata was shared for this connection.";

  return [rules, context, schemaBlock].join("\n\n");
}

/** Editor text sent as reference is capped this size (roughly) to keep the request small. */
const EDITOR_REFERENCE_LIMIT = 4000;

export interface GenerateMessageInput {
  instruction: string;
  /** The selected SQL to rewrite; when absent, a new statement is generated instead. */
  selection?: string;
  /** Surrounding editor content, used as reference only, and only when there is no selection. */
  editorText?: string;
}

export function buildGenerateMessage({ instruction, selection, editorText }: GenerateMessageInput): string {
  const trimmedInstruction = instruction.trim();

  if (selection?.trim()) {
    return [
      "Rewrite the following SQL according to the instruction.",
      "",
      `Instruction: ${trimmedInstruction}`,
      "",
      "```sql",
      selection,
      "```",
    ].join("\n");
  }

  const lines = [`Write a new SQL statement for this request: ${trimmedInstruction}`];
  if (editorText?.trim()) {
    lines.push(
      "",
      "For reference only (context — do not repeat it back verbatim), here is the surrounding editor content:",
      "```sql",
      editorText.slice(0, EDITOR_REFERENCE_LIMIT),
      "```",
    );
  }
  return lines.join("\n");
}

export interface FixMessageInput {
  sql: string;
  error: string;
}

export function buildFixMessage({ sql, error }: FixMessageInput): string {
  return [
    "The following statement failed. Fix it and reply with the corrected, complete statement.",
    "",
    "```sql",
    sql,
    "```",
    "",
    `Error: ${error}`,
  ].join("\n");
}

export interface ExplainMessageInput {
  sql: string;
}

/** Chat message for the "Explain query" feature: asks the model to narrate what a statement does. */
export function buildExplainMessage({ sql }: ExplainMessageInput): string {
  return [
    "Explain what the following statement does, step by step, in plain language. Cover:",
    "- the sources and joins",
    "- the filters applied",
    "- grouping/aggregation, if any",
    "- ordering and limits, if any",
    "- the shape of the result",
    "",
    "Point out any likely bugs or surprising behavior.",
    "",
    "```sql",
    sql,
    "```",
  ].join("\n");
}

export interface OptimizeMessageInput {
  sql: string;
  /** Rendered execution plan (see `formatResultAsText`), when EXPLAIN could be run. */
  plan?: string | null;
  /** EXPLAIN's own error, when it failed to run. */
  planError?: string | null;
}

/**
 * Chat message for the "Optimize query" feature: asks for a performance review grounded in the
 * statement's execution plan. `plan`/`planError` are mutually exclusive; when neither is given, the
 * message notes that no plan is available (e.g. the engine has no usable EXPLAIN).
 */
export function buildOptimizeMessage({ sql, plan, planError }: OptimizeMessageInput): string {
  const planSection = plan
    ? ["Execution plan:", "```text", plan, "```"]
    : planError
      ? [`The execution plan could not be retrieved: ${planError}`]
      : ["No execution plan is available for this engine."];

  return [
    "Review the performance of the following statement, using the execution plan below.",
    "",
    "```sql",
    sql,
    "```",
    "",
    ...planSection,
    "",
    "Cover:",
    "- the bottleneck",
    "- a rewritten statement, if it would help (in a ```sql block)",
    "- indexes to add, as CREATE INDEX statements, with reasoning for each",
    "- trade-offs of the suggested changes",
    "",
    "If the statement is already fine as written, say so.",
  ].join("\n");
}

/**
 * Extracts the content of the first fenced code block in the model's reply (any language tag).
 * Tolerates an unterminated fence — the reply is still streaming in — by taking everything up to
 * the end of the text. Falls back to the trimmed text when there is no fence at all.
 */
export function extractSql(text: string): string {
  const match = /```[^\n]*\n([\s\S]*?)(?:```|$)/.exec(text);
  return match ? match[1].trim() : text.trim();
}

/**
 * Strips line comments (`--`, `#`), block comments and string/identifier literals — roughly: good
 * enough to keep the keyword detection below from tripping on a comment or a quoted value.
 */
function stripCommentsAndStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--" || sql[i] === "#") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * A rough, statement-aware check for destructive SQL: DROP/TRUNCATE anywhere, or a DELETE/UPDATE
 * statement with no WHERE clause. Comments and string/identifier literals are stripped first so a
 * keyword mentioned only in a comment or a quoted value does not trigger a false positive.
 */
export function isDestructiveSql(sql: string): boolean {
  const cleaned = stripCommentsAndStrings(sql).toUpperCase();
  if (/\bDROP\b/.test(cleaned) || /\bTRUNCATE\b/.test(cleaned)) return true;

  return cleaned.split(";").some((statement) => {
    const touchesRows = /\bDELETE\b/.test(statement) || /\bUPDATE\b/.test(statement);
    return touchesRows && !/\bWHERE\b/.test(statement);
  });
}

/**
 * Trims a side chat's history down to the most recent messages within both a message-count and a
 * character budget, for a request that always ends with the latest message. The last message is
 * always kept, even alone over `maxChars` (better an oversized request than a chat that silently
 * drops what the user just sent), and a leading assistant message left dangling by the trim is
 * dropped so the trimmed history always starts with a user turn — which is what a chat request
 * with alternating roles requires.
 */
export function trimChatHistory(
  messages: AiMessage[],
  { maxMessages = 20, maxChars = 60000 }: { maxMessages?: number; maxChars?: number } = {},
): AiMessage[] {
  if (messages.length === 0) return [];

  const last = messages[messages.length - 1];
  const kept: AiMessage[] = [last];
  let used = last.content.length;

  for (let i = messages.length - 2; i >= 0 && kept.length < maxMessages; i--) {
    const message = messages[i];
    if (used + message.content.length > maxChars) break;
    kept.unshift(message);
    used += message.content.length;
  }

  while (kept.length > 1 && kept[0].role !== "user") {
    kept.shift();
  }

  return kept;
}
