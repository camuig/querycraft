import { describe, expect, it } from "vitest";
import { buildInlineSystemPrompt, buildInlineUserMessage, cleanCompletion, shouldTriggerInline } from "../inline";

describe("shouldTriggerInline", () => {
  it("triggers at the end of a line with enough typed content", () => {
    expect(shouldTriggerInline("SELECT * FROM ", "")).toBe(true);
  });

  it("does not trigger with fewer than 3 non-space characters typed", () => {
    expect(shouldTriggerInline("ab", "")).toBe(false);
    expect(shouldTriggerInline("  a b", "")).toBe(false);
  });

  it("triggers before a closing paren, comma or semicolon", () => {
    expect(shouldTriggerInline("SELECT id", ")")).toBe(true);
    expect(shouldTriggerInline("SELECT id", ",")).toBe(true);
    expect(shouldTriggerInline("SELECT id", ";")).toBe(true);
  });

  it("triggers before whitespace or a newline", () => {
    expect(shouldTriggerInline("SELECT id", " FROM t")).toBe(true);
    expect(shouldTriggerInline("SELECT id", "\nFROM t")).toBe(true);
  });

  it("does not trigger in the middle of a word", () => {
    expect(shouldTriggerInline("SELECT id", "x FROM t")).toBe(false);
  });

  it("does not trigger inside an unterminated string literal", () => {
    expect(shouldTriggerInline("SELECT * FROM t WHERE name = 'abc", "")).toBe(false);
  });

  it("does not trigger inside a line comment", () => {
    expect(shouldTriggerInline("SELECT 1; -- explain this query", "")).toBe(false);
  });

  it("triggers again on the next line after a closed string or comment", () => {
    expect(shouldTriggerInline("SELECT * FROM t WHERE name = 'abc'\nAND ", "")).toBe(true);
    expect(shouldTriggerInline("-- a short note\nSELECT ", "")).toBe(true);
  });

  it("considers the current statement, not just the current line", () => {
    // Short current line ("id,"), but the statement so far has plenty of content.
    expect(shouldTriggerInline("SELECT customers.id,\n", "")).toBe(true);
  });

  it("does not trigger right after a statement boundary with little typed yet", () => {
    expect(shouldTriggerInline("SELECT 1;\nab", "")).toBe(false);
  });
});

describe("buildInlineSystemPrompt", () => {
  it("names the engine and states the autocomplete-only contract", () => {
    const prompt = buildInlineSystemPrompt({ dialectLabel: "MySQL" });
    expect(prompt).toContain("SQL autocomplete engine for MySQL");
    expect(prompt).toContain("no code fences");
    expect(prompt).toContain("empty message");
  });

  it("includes the server version when given", () => {
    const prompt = buildInlineSystemPrompt({ dialectLabel: "MySQL", serverVersion: "8.0.44" });
    expect(prompt).toContain("MySQL 8.0.44");
  });

  it("includes the current database and notes its absence", () => {
    expect(buildInlineSystemPrompt({ dialectLabel: "MySQL", database: "shop" })).toContain("Current database: shop");
    expect(buildInlineSystemPrompt({ dialectLabel: "MySQL" })).toContain("(none selected)");
  });

  it("embeds the schema when given, and notes its absence otherwise", () => {
    expect(buildInlineSystemPrompt({ dialectLabel: "MySQL", schema: "CREATE TABLE t (id int);" })).toContain(
      "CREATE TABLE t (id int);",
    );
    expect(buildInlineSystemPrompt({ dialectLabel: "MySQL" })).toContain("No schema metadata was shared");
  });

  it("is deterministic for the same context (needed for prompt caching)", () => {
    const ctx = { dialectLabel: "MySQL", serverVersion: "8.0.44", database: "shop", schema: "CREATE TABLE t();" };
    expect(buildInlineSystemPrompt(ctx)).toBe(buildInlineSystemPrompt({ ...ctx }));
  });
});

describe("buildInlineUserMessage", () => {
  it("wraps prefix and suffix around a <CURSOR> marker", () => {
    const message = buildInlineUserMessage("SELECT * FROM ", " WHERE id = 1;");
    expect(message).toContain("SELECT * FROM <CURSOR> WHERE id = 1;");
    expect(message).toContain("```sql");
  });

  it("caps the prefix to the last 4000 characters", () => {
    const long = `${"a".repeat(5000)}SELECT`;
    const message = buildInlineUserMessage(long, "");
    expect(message).not.toContain("a".repeat(4001));
    expect(message).toContain("SELECT<CURSOR>");
  });

  it("caps the suffix to the first 1000 characters", () => {
    const long = `FROM t${"b".repeat(5000)}`;
    const message = buildInlineUserMessage("", long);
    expect(message).not.toContain("b".repeat(1001));
    expect(message).toContain("<CURSOR>FROM t");
  });
});

describe("cleanCompletion", () => {
  it("strips a fenced code block", () => {
    expect(cleanCompletion("```sql\nWHERE id = 1\n```", "SELECT * FROM t ", "")).toBe("WHERE id = 1");
  });

  it("strips a fence with no language tag", () => {
    expect(cleanCompletion("```\nWHERE id = 1\n```", "SELECT * FROM t ", "")).toBe("WHERE id = 1");
  });

  it("strips an echoed <CURSOR> marker", () => {
    expect(cleanCompletion("<CURSOR>WHERE id = 1", "SELECT * FROM t ", "")).toBe("WHERE id = 1");
  });

  it("strips an echoed overlap with the end of the prefix", () => {
    expect(cleanCompletion("FROM orders WHERE id = 1", "SELECT * FROM ", "")).toBe("orders WHERE id = 1");
  });

  it("strips an echoed overlap with the start of the suffix", () => {
    expect(cleanCompletion("WHERE id = 1 ORDER BY", "SELECT * FROM t ", " ORDER BY id")).toBe("WHERE id = 1");
  });

  it("avoids a double space when the prefix already ends with whitespace", () => {
    expect(cleanCompletion(" WHERE id = 1", "SELECT * FROM t ", "")).toBe("WHERE id = 1");
  });

  it("keeps leading whitespace when the prefix does not end with whitespace", () => {
    expect(cleanCompletion("  id\n  name", "SELECT\n", "")).toBe("  id\n  name");
  });

  it("caps the result to 8 lines", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `col${i}`);
    const raw = lines.join(",\n");
    const result = cleanCompletion(raw, "SELECT ", "");
    expect(result.split("\n")).toHaveLength(8);
    expect(result).not.toContain("col8");
  });

  it("returns an empty string for a whitespace-only reply", () => {
    expect(cleanCompletion("   \n  ", "SELECT * FROM t ", "")).toBe("");
    expect(cleanCompletion("", "SELECT * FROM t ", "")).toBe("");
  });
});
