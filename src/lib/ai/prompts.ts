// System/user prompt builders for the two MVP features (Generate SQL, Fix error) and the helpers
// that parse the model's reply back into a statement. Pure functions only.

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
