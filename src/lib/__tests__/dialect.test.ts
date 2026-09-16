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
});
