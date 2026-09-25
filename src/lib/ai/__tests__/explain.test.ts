import { describe, expect, it } from "vitest";
import type { CellValue, ColumnMeta, StatementResult } from "../../../api/types";
import { explainSqlFor, formatResultAsText, isExplainable } from "../explain";

describe("isExplainable", () => {
  it("is true for reads and row-touching writes", () => {
    expect(isExplainable("SELECT * FROM t")).toBe(true);
    expect(isExplainable("  with cte as (select 1) select * from cte")).toBe(true);
    expect(isExplainable("update t set a = 1")).toBe(true);
    expect(isExplainable("DELETE FROM t")).toBe(true);
    expect(isExplainable("insert into t values (1)")).toBe(true);
    expect(isExplainable("replace into t values (1)")).toBe(true);
    expect(isExplainable("table t")).toBe(true);
    expect(isExplainable("values (1), (2)")).toBe(true);
  });

  it("is false for DDL and session statements", () => {
    expect(isExplainable("CREATE TABLE t (id int)")).toBe(false);
    expect(isExplainable("DROP TABLE t")).toBe(false);
    expect(isExplainable("SET autocommit = 1")).toBe(false);
    expect(isExplainable("USE shop")).toBe(false);
    expect(isExplainable("SHOW TABLES")).toBe(false);
  });

  it("is false for a statement already starting with EXPLAIN", () => {
    expect(isExplainable("EXPLAIN SELECT * FROM t")).toBe(false);
  });

  it("skips leading comments and whitespace", () => {
    expect(isExplainable("  -- a comment\n/* another */ SELECT 1")).toBe(true);
    expect(isExplainable("-- SELECT is a lie\nDROP TABLE t")).toBe(false);
  });

  it("is false for empty input", () => {
    expect(isExplainable("")).toBe(false);
    expect(isExplainable("   ")).toBe(false);
  });
});

describe("explainSqlFor", () => {
  it("uses a plain EXPLAIN for mysql below 8.0.18", () => {
    expect(explainSqlFor("mysql", "SELECT * FROM t", "8.0.17")).toBe("EXPLAIN SELECT * FROM t");
  });

  it("uses FORMAT=TREE for mysql 8.0.18 and above", () => {
    expect(explainSqlFor("mysql", "SELECT * FROM t", "8.0.18")).toBe("EXPLAIN FORMAT=TREE SELECT * FROM t");
    expect(explainSqlFor("mysql", "SELECT * FROM t", "8.4.0")).toBe("EXPLAIN FORMAT=TREE SELECT * FROM t");
  });

  it("falls back to a plain EXPLAIN for mysql when the version is missing or unparsable", () => {
    expect(explainSqlFor("mysql", "SELECT * FROM t")).toBe("EXPLAIN SELECT * FROM t");
    expect(explainSqlFor("mysql", "SELECT * FROM t", "unknown")).toBe("EXPLAIN SELECT * FROM t");
  });

  it("never emits FORMAT=TREE for mariadb, even with a mysql-shaped version string", () => {
    expect(explainSqlFor("mariadb", "SELECT * FROM t", "10.11.6-MariaDB")).toBe("EXPLAIN SELECT * FROM t");
  });

  it("uses the right EXPLAIN form per engine", () => {
    expect(explainSqlFor("postgres", "SELECT * FROM t")).toBe("EXPLAIN SELECT * FROM t");
    expect(explainSqlFor("sqlite", "SELECT * FROM t")).toBe("EXPLAIN QUERY PLAN SELECT * FROM t");
    expect(explainSqlFor("clickhouse", "SELECT * FROM t")).toBe("EXPLAIN indexes = 1 SELECT * FROM t");
  });

  it("returns null for engines with no usable EXPLAIN", () => {
    expect(explainSqlFor("mssql", "SELECT * FROM t")).toBeNull();
    expect(explainSqlFor("redis", "GET foo")).toBeNull();
    expect(explainSqlFor("valkey", "GET foo")).toBeNull();
  });

  it("returns null for non-explainable statements", () => {
    expect(explainSqlFor("mysql", "SET autocommit=1")).toBeNull();
    expect(explainSqlFor("mysql", "CREATE TABLE t (id int)")).toBeNull();
  });

  it("strips a trailing semicolon and surrounding whitespace", () => {
    expect(explainSqlFor("postgres", "  SELECT 1;  ")).toBe("EXPLAIN SELECT 1");
  });

  it("returns an already-EXPLAINed statement unchanged", () => {
    expect(explainSqlFor("mysql", "EXPLAIN SELECT * FROM t")).toBe("EXPLAIN SELECT * FROM t");
    expect(explainSqlFor("postgres", "explain (format json) select 1")).toBe("explain (format json) select 1");
  });

  it("never emits ANALYZE: returns null for an EXPLAIN ANALYZE statement", () => {
    expect(explainSqlFor("postgres", "EXPLAIN ANALYZE SELECT * FROM t")).toBeNull();
    expect(explainSqlFor("mysql", "explain analyze select 1")).toBeNull();
  });

  it("returns null for an empty statement", () => {
    expect(explainSqlFor("mysql", "  ;  ")).toBeNull();
  });
});

function col(name: string): ColumnMeta {
  return {
    name,
    table: null,
    database: null,
    typeName: "VARCHAR",
    unsigned: false,
    nullable: true,
    primaryKey: false,
    binary: false,
  };
}

function result(overrides: Partial<StatementResult>): StatementResult {
  return {
    sql: "EXPLAIN SELECT 1",
    kind: "rows",
    columns: [],
    rows: [],
    truncated: false,
    affectedRows: 0,
    lastInsertId: null,
    error: null,
    durationMs: 1,
    ...overrides,
  };
}

describe("formatResultAsText", () => {
  it("reports a failed EXPLAIN as an error line", () => {
    const r = result({ kind: "error", error: "syntax error" });
    expect(formatResultAsText(r)).toBe("EXPLAIN failed: syntax error");
  });

  it("joins single-column rows by newline with no header", () => {
    const r = result({
      columns: [col("QUERY PLAN")],
      rows: [["Seq Scan on t"], ["  Filter: id = 1"]],
    });
    expect(formatResultAsText(r)).toBe("Seq Scan on t\n  Filter: id = 1");
  });

  it("renders a multi-column result as an aligned table with a header", () => {
    const r = result({
      columns: [col("id"), col("select_type")],
      rows: [
        [1, "SIMPLE"],
        [2, "SUBQUERY"],
      ],
    });
    const lines = formatResultAsText(r).split("\n");
    expect(lines[0]).toBe("id  select_type");
    expect(lines[1]).toBe("--  -----------");
    expect(lines[2]).toBe("1   SIMPLE");
    expect(lines[3]).toBe("2   SUBQUERY");
  });

  it("renders null as NULL and objects as JSON", () => {
    // A JSON column can arrive as an already-parsed object; `CellValue` doesn't model that, but
    // formatResultAsText must still render it sensibly rather than crash.
    const jsonCell = { x: 1 } as unknown as CellValue;
    const r = result({ columns: [col("a"), col("b")], rows: [[null, jsonCell]] });
    const text = formatResultAsText(r);
    expect(text).toContain("NULL");
    expect(text).toContain('{"x":1}');
  });

  it("truncates rows past maxRows and notes how many were left out", () => {
    const rows = Array.from({ length: 5 }, (_, i) => [i]);
    const r = result({ columns: [col("n")], rows });
    const text = formatResultAsText(r, { maxRows: 2 });
    expect(text).toContain("… (3 more rows)");
    expect(text.split("\n").filter((l) => /^\d+$/.test(l)).length).toBe(2);
  });

  it("does not add a truncation note when every row fits", () => {
    const r = result({ columns: [col("n")], rows: [[1], [2]] });
    expect(formatResultAsText(r, { maxRows: 200 })).not.toContain("more rows");
  });

  it("caps the total output length", () => {
    const r = result({ columns: [col("n")], rows: [["a".repeat(100)]] });
    const text = formatResultAsText(r, { maxChars: 10 });
    expect(text.length).toBeLessThanOrEqual(10 + "\n… (truncated)".length);
    expect(text).toContain("truncated");
  });
});
