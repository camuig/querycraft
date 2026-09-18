import { describe, expect, it } from "vitest";
import { DB_KINDS, DIALECTS, dialectFor } from "../dialect";

describe("dialects", () => {
  it("covers every kind offered in the dialog", () => {
    for (const kind of DB_KINDS) {
      expect(dialectFor(kind).kind).toBe(kind);
    }
    expect(Object.keys(DIALECTS).sort()).toEqual([...DB_KINDS].sort());
  });

  it("uses double quotes for PostgreSQL and SQLite, backticks elsewhere", () => {
    expect(dialectFor("postgres").identifierQuote).toBe('"');
    expect(dialectFor("sqlite").identifierQuote).toBe('"');
    expect(dialectFor("mysql").identifierQuote).toBe("`");
    expect(dialectFor("mariadb").identifierQuote).toBe("`");
    expect(dialectFor("clickhouse").identifierQuote).toBe("`");
  });

  it("marks ClickHouse read-only and SQLite file-based", () => {
    expect(dialectFor("clickhouse").supportsEditing).toBe(false);
    expect(dialectFor("sqlite").fileBased).toBe(true);
    expect(dialectFor("postgres").requiresDatabase).toBe(true);
  });

  it("gives Redis and Valkey the redis query language, port 6379 and a read-only, user-less default", () => {
    for (const kind of ["redis", "valkey"] as const) {
      const dialect = dialectFor(kind);
      expect(dialect.queryLanguage).toBe("redis");
      expect(dialect.defaultPort).toBe(6379);
      expect(dialect.defaultUser).toBe("");
      expect(dialect.defaultDatabase).toBe("0");
      expect(dialect.supportsEditing).toBe(false);
    }
  });
});
