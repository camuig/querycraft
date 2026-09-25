import { describe, expect, it } from "vitest";
import {
  buildFixMessage,
  buildGenerateMessage,
  buildSystemPrompt,
  extractSql,
  isDestructiveSql,
  type PromptContext,
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
