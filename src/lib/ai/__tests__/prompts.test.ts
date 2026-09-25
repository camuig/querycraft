import { describe, expect, it } from "vitest";
import type { AiMessage } from "../../../api/types";
import {
  buildChatSystemPrompt,
  buildExplainMessage,
  buildFixMessage,
  buildGenerateMessage,
  buildOptimizeMessage,
  buildSystemPrompt,
  extractSql,
  isDestructiveSql,
  type PromptContext,
  trimChatHistory,
} from "../prompts";

const baseCtx: PromptContext = { dialectLabel: "MySQL", queryLanguage: "sql" };

describe("buildSystemPrompt", () => {
  it("names the dialect and requires a single fenced sql block", () => {
    const prompt = buildSystemPrompt(baseCtx);
    expect(prompt).toContain("expert MySQL assistant");
    expect(prompt).toContain("```sql");
    expect(prompt).not.toContain("```redis");
  });

  it("uses a redis fence for the redis query language", () => {
    const prompt = buildSystemPrompt({ dialectLabel: "Redis", queryLanguage: "redis" });
    expect(prompt).toContain("```redis");
  });

  it("includes the server version and current database when given", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, serverVersion: "8.0.44", database: "shop" });
    expect(prompt).toContain("8.0.44");
    expect(prompt).toContain("Current database: shop");
  });

  it("says no database is selected when database is null", () => {
    expect(buildSystemPrompt({ ...baseCtx, database: null })).toContain("(none selected)");
  });

  it("embeds the schema block when a schema is given, and notes its absence otherwise", () => {
    const withSchema = buildSystemPrompt({ ...baseCtx, schema: "CREATE TABLE t (id int);" });
    expect(withSchema).toContain("CREATE TABLE t (id int);");
    expect(withSchema).toContain("never invent tables or columns");

    const withoutSchema = buildSystemPrompt(baseCtx);
    expect(withoutSchema).toContain("No schema metadata was shared");
  });

  it("is deterministic for the same context (needed for prompt caching)", () => {
    const ctx: PromptContext = { ...baseCtx, serverVersion: "8.0.44", database: "shop", schema: "CREATE TABLE t();" };
    expect(buildSystemPrompt(ctx)).toBe(buildSystemPrompt({ ...ctx }));
  });
});

describe("buildChatSystemPrompt", () => {
  it("names the dialect, targets Markdown and warns about destructive statements", () => {
    const prompt = buildChatSystemPrompt(baseCtx);
    expect(prompt).toContain("expert MySQL assistant inside a database client, chatting with a developer");
    expect(prompt).toContain("Markdown");
    expect(prompt).toContain("```sql");
    expect(prompt.toLowerCase()).toContain("reply in the language of the user's latest message");
    expect(prompt.toLowerCase()).toContain("cannot run queries");
    expect(prompt).toContain("Warn clearly before suggesting any destructive statement");
  });

  it("uses a redis fence for the redis query language", () => {
    expect(buildChatSystemPrompt({ dialectLabel: "Redis", queryLanguage: "redis" })).toContain("```redis");
  });

  it("includes the same context section as buildSystemPrompt", () => {
    const ctx: PromptContext = { ...baseCtx, serverVersion: "8.0.44", database: "shop" };
    const prompt = buildChatSystemPrompt(ctx);
    expect(prompt).toContain("Engine: MySQL 8.0.44");
    expect(prompt).toContain("Current database: shop");
  });

  it("embeds the schema when given, and notes it is not shared otherwise", () => {
    const withSchema = buildChatSystemPrompt({ ...baseCtx, schema: "CREATE TABLE t (id int);" });
    expect(withSchema).toContain("CREATE TABLE t (id int);");

    const withoutSchema = buildChatSystemPrompt(baseCtx);
    expect(withoutSchema).toContain("No schema metadata was shared");
  });

  it("is deterministic for the same context", () => {
    const ctx: PromptContext = { ...baseCtx, serverVersion: "8.0.44", database: "shop", schema: "CREATE TABLE t();" };
    expect(buildChatSystemPrompt(ctx)).toBe(buildChatSystemPrompt({ ...ctx }));
  });
});

describe("buildExplainMessage", () => {
  it("asks for a step-by-step explanation and includes the statement", () => {
    const message = buildExplainMessage({ sql: "SELECT * FROM orders WHERE id = 1" });
    expect(message).toContain("step by step");
    expect(message).toContain("likely bugs");
    expect(message).toContain("```sql\nSELECT * FROM orders WHERE id = 1\n```");
  });
});

describe("buildOptimizeMessage", () => {
  it("includes the plan as a text block when given", () => {
    const message = buildOptimizeMessage({ sql: "SELECT 1", plan: "Seq Scan on t" });
    expect(message).toContain("```text\nSeq Scan on t\n```");
    expect(message).toContain("CREATE INDEX");
  });

  it("notes the EXPLAIN error when the plan failed", () => {
    const message = buildOptimizeMessage({ sql: "SELECT 1", planError: "syntax error" });
    expect(message).toContain("could not be retrieved: syntax error");
    expect(message).not.toContain("```text");
  });

  it("notes no plan is available when neither plan nor error is given", () => {
    const message = buildOptimizeMessage({ sql: "SELECT 1" });
    expect(message).toContain("No execution plan is available for this engine.");
  });

  it("asks about rewriting, indexes and trade-offs", () => {
    const message = buildOptimizeMessage({ sql: "SELECT 1", plan: "plan" });
    expect(message).toContain("bottleneck");
    expect(message).toContain("trade-offs");
    expect(message).toContain("already fine");
  });
});

describe("trimChatHistory", () => {
  function msg(role: AiMessage["role"], content: string): AiMessage {
    return { role, content };
  }

  it("keeps everything when under both limits", () => {
    const messages = [msg("user", "hi"), msg("assistant", "hello")];
    expect(trimChatHistory(messages)).toEqual(messages);
  });

  it("returns an empty array for an empty history", () => {
    expect(trimChatHistory([])).toEqual([]);
  });

  it("keeps only the most recent maxMessages, always ending with the last message", () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `m${i}`));
    const trimmed = trimChatHistory(messages, { maxMessages: 4 });
    expect(trimmed.length).toBeLessThanOrEqual(4);
    expect(trimmed[trimmed.length - 1]).toEqual(messages[messages.length - 1]);
  });

  it("drops older messages once the character budget is exceeded", () => {
    const messages = [msg("user", "a".repeat(100)), msg("assistant", "b".repeat(100)), msg("user", "c".repeat(100))];
    const trimmed = trimChatHistory(messages, { maxChars: 150 });
    expect(trimmed).toEqual([messages[2]]);
  });

  it("never drops the last message even if it alone exceeds maxChars", () => {
    const messages = [msg("user", "small"), msg("assistant", "a".repeat(1000))];
    const trimmed = trimChatHistory(messages, { maxChars: 10 });
    expect(trimmed).toEqual([messages[1]]);
  });

  it("drops a leading assistant message so the result starts with a user message", () => {
    const messages = [msg("user", "u1"), msg("assistant", "a1"), msg("assistant", "a2"), msg("user", "u2")];
    const trimmed = trimChatHistory(messages, { maxMessages: 3 });
    expect(trimmed[0].role).toBe("user");
    expect(trimmed[trimmed.length - 1]).toEqual(messages[messages.length - 1]);
  });
});

describe("buildGenerateMessage", () => {
  it("asks to rewrite the selection when one is given", () => {
    const message = buildGenerateMessage({ instruction: "only paid orders", selection: "SELECT * FROM orders" });
    expect(message).toContain("Rewrite the following SQL according to the instruction");
    expect(message).toContain("only paid orders");
    expect(message).toContain("```sql\nSELECT * FROM orders\n```");
  });

  it("asks for a new statement when there is no selection", () => {
    const message = buildGenerateMessage({ instruction: "top 5 customers by spend" });
    expect(message).toContain("top 5 customers by spend");
    expect(message).not.toContain("Rewrite the following SQL");
  });

  it("includes the editor text as reference only when there is no selection", () => {
    const withReference = buildGenerateMessage({ instruction: "x", editorText: "SELECT 1;" });
    expect(withReference).toContain("SELECT 1;");
    expect(withReference).toContain("reference only");

    const withSelection = buildGenerateMessage({ instruction: "x", selection: "SELECT 2", editorText: "SELECT 1;" });
    expect(withSelection).not.toContain("SELECT 1;");
  });

  it("caps the editor text reference to ~4000 characters", () => {
    const long = "a".repeat(5000);
    const message = buildGenerateMessage({ instruction: "x", editorText: long });
    expect(message).toContain("a".repeat(4000));
    expect(message).not.toContain("a".repeat(4001));
  });
});

describe("buildFixMessage", () => {
  it("includes the failed statement and the error", () => {
    const message = buildFixMessage({ sql: "SELECT * FROM nope", error: "Table 'nope' doesn't exist" });
    expect(message).toContain("SELECT * FROM nope");
    expect(message).toContain("Table 'nope' doesn't exist");
  });
});

describe("extractSql", () => {
  it("extracts the content of a fenced code block", () => {
    expect(extractSql("Here:\n```sql\nSELECT 1;\n```\nDone.")).toBe("SELECT 1;");
  });

  it("works with no language tag", () => {
    expect(extractSql("```\nSELECT 1;\n```")).toBe("SELECT 1;");
  });

  it("tolerates an unterminated fence while streaming", () => {
    expect(extractSql("```sql\nSELECT 1")).toBe("SELECT 1");
  });

  it("falls back to the trimmed text when there is no fence", () => {
    expect(extractSql("  SELECT 1;  ")).toBe("SELECT 1;");
  });

  it("only extracts the first fenced block", () => {
    expect(extractSql("```sql\nSELECT 1\n```\nsome text\n```sql\nSELECT 2\n```")).toBe("SELECT 1");
  });
});

describe("isDestructiveSql", () => {
  it("flags DROP and TRUNCATE", () => {
    expect(isDestructiveSql("DROP TABLE users")).toBe(true);
    expect(isDestructiveSql("TRUNCATE orders")).toBe(true);
  });

  it("flags ALTER ... DROP", () => {
    expect(isDestructiveSql("ALTER TABLE t DROP COLUMN x")).toBe(true);
  });

  it("flags DELETE/UPDATE without a WHERE clause", () => {
    expect(isDestructiveSql("DELETE FROM users")).toBe(true);
    expect(isDestructiveSql("UPDATE users SET active = 0")).toBe(true);
  });

  it("does not flag DELETE/UPDATE with a WHERE clause", () => {
    expect(isDestructiveSql("DELETE FROM users WHERE id = 1")).toBe(false);
    expect(isDestructiveSql("UPDATE users SET active = 0 WHERE id = 1")).toBe(false);
  });

  it("does not flag an ordinary SELECT", () => {
    expect(isDestructiveSql("SELECT * FROM users")).toBe(false);
  });

  it("ignores keywords inside comments and string literals", () => {
    expect(isDestructiveSql("-- DROP TABLE users\nSELECT 1")).toBe(false);
    expect(isDestructiveSql("SELECT * FROM logs WHERE msg = 'DELETE issued'")).toBe(false);
  });

  it("checks each statement independently in a multi-statement batch", () => {
    expect(isDestructiveSql("UPDATE t SET x = 1 WHERE id = 1; DELETE FROM t2 WHERE id = 2;")).toBe(false);
    expect(isDestructiveSql("UPDATE t SET x = 1 WHERE id = 1; DELETE FROM t2;")).toBe(true);
  });
});
