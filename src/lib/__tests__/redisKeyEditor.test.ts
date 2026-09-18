import { describe, expect, it } from "vitest";
import type { CellValue, ColumnMeta } from "../../api/types";
import { ChangeTracker } from "../changeTracker";
import { buildKeyStatements, keyEditCapabilities, keyLoadCommand, withListIndexColumn } from "../redisKeyEditor";

function col(name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    table: null,
    database: null,
    typeName: "TEXT",
    unsigned: false,
    nullable: true,
    primaryKey: false,
    binary: false,
    ...extra,
  };
}

function tracker(rows: CellValue[][], columns: ColumnMeta[]): ChangeTracker {
  return new ChangeTracker(rows, columns, [], "redis");
}

describe("keyLoadCommand", () => {
  it("picks the full-range command per type", () => {
    expect(keyLoadCommand("k", "string")).toBe('GET "k"');
    expect(keyLoadCommand("k", "hash")).toBe('HGETALL "k"');
    expect(keyLoadCommand("k", "list")).toBe('LRANGE "k" 0 -1');
    expect(keyLoadCommand("k", "set")).toBe('SMEMBERS "k"');
    expect(keyLoadCommand("k", "zset")).toBe('ZRANGE "k" 0 -1 WITHSCORES');
    expect(keyLoadCommand("k", "stream")).toBe('XRANGE "k" - + COUNT 500');
  });

  it("falls back to TYPE for unknown types", () => {
    expect(keyLoadCommand("k", "none")).toBe('TYPE "k"');
  });
});

describe("keyEditCapabilities", () => {
  it("allows full editing for hash/list/set/zset", () => {
    for (const t of ["hash", "list", "set", "zset"]) {
      expect(keyEditCapabilities(t)).toEqual({ cellEdit: true, canInsert: true, canDelete: true });
    }
  });

  it("allows only value edits for a string (no add/delete row)", () => {
    expect(keyEditCapabilities("string")).toEqual({ cellEdit: true, canInsert: false, canDelete: false });
  });

  it("allows only row deletion for a stream", () => {
    expect(keyEditCapabilities("stream")).toEqual({ cellEdit: false, canInsert: false, canDelete: true });
  });

  it("is fully read-only for an unknown type", () => {
    expect(keyEditCapabilities("none")).toEqual({ cellEdit: false, canInsert: false, canDelete: false });
  });
});

describe("withListIndexColumn", () => {
  it("prepends a 0-based index column and value", () => {
    const columns = [col("element")];
    const rows: CellValue[][] = [["a"], ["b"], ["c"]];
    const result = withListIndexColumn(columns, rows);
    expect(result.columns.map((c) => c.name)).toEqual(["index", "element"]);
    expect(result.columns[0].binary).toBe(true);
    expect(result.rows).toEqual([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ]);
  });
});

describe("buildKeyStatements — always leads with SELECT", () => {
  it("prepends SELECT <db> before any command", () => {
    const columns = [col("value")];
    const rows: CellValue[][] = [["hello"]];
    const t = tracker(rows, columns).setCell(0, 0, "world");
    const result = buildKeyStatements("3", "k", "string", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements[0]).toEqual({ sql: "SELECT", params: ["3"] });
  });
});

describe("buildKeyStatements — string", () => {
  const columns = [col("value")];

  it("edits the value with SET ... KEEPTTL", () => {
    const rows: CellValue[][] = [["hello"]];
    const t = tracker(rows, columns).setCell(0, 0, "world");
    const result = buildKeyStatements("0", "k", "string", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements).toEqual([
      { sql: "SELECT", params: ["0"] },
      { sql: "SET", params: ["k", "world", "KEEPTTL"] },
    ]);
  });

  it("produces no command beyond SELECT when nothing changed", () => {
    const rows: CellValue[][] = [["hello"]];
    const t = tracker(rows, columns);
    const result = buildKeyStatements("0", "k", "string", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements).toHaveLength(1);
  });

  it("rejects an empty value", () => {
    const rows: CellValue[][] = [["hello"]];
    const t = tracker(rows, columns).setCell(0, 0, null);
    const result = buildKeyStatements("0", "k", "string", rows, t, columns);
    expect(result).toEqual({ ok: false, error: "Value is required" });
  });
});

describe("buildKeyStatements — hash", () => {
  const columns = [col("field"), col("value")];
  const rows: CellValue[][] = [
    ["a", "1"],
    ["b", "2"],
  ];

  it("deletes a row with HDEL", () => {
    const t = tracker(rows, columns).deleteRow(1);
    const result = buildKeyStatements("0", "k", "hash", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "HDEL", params: ["k", "b"] }]);
  });

  it("updates a value in place with HSET", () => {
    const t = tracker(rows, columns).setCell(0, 1, "99");
    const result = buildKeyStatements("0", "k", "hash", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "HSET", params: ["k", "a", "99"] }]);
  });

  it("renames a field with HDEL(old) + HSET(new)", () => {
    const t = tracker(rows, columns).setCell(0, 0, "aa");
    const result = buildKeyStatements("0", "k", "hash", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([
      { sql: "HDEL", params: ["k", "a"] },
      { sql: "HSET", params: ["k", "aa", "1"] },
    ]);
  });

  it("inserts a new field/value pair", () => {
    const { tracker: t1, rowIndex } = tracker(rows, columns).insertRow();
    const t2 = t1.setCell(rowIndex, 0, "c").setCell(rowIndex, 1, "3");
    const result = buildKeyStatements("0", "k", "hash", rows, t2, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "HSET", params: ["k", "c", "3"] }]);
  });

  it("rejects an insert missing the field or the value", () => {
    const { tracker: t1, rowIndex } = tracker(rows, columns).insertRow();
    const t2 = t1.setCell(rowIndex, 0, "c");
    const result = buildKeyStatements("0", "k", "hash", rows, t2, columns);
    expect(result).toEqual({ ok: false, error: "Field and value are required" });
  });

  it("orders deletes before updates before inserts", () => {
    const t0 = tracker(rows, columns).deleteRow(1).setCell(0, 1, "99");
    const { tracker: t1, rowIndex } = t0.insertRow();
    const t2 = t1.setCell(rowIndex, 0, "c").setCell(rowIndex, 1, "3");
    const result = buildKeyStatements("0", "k", "hash", rows, t2, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const cmds = result.statements.slice(1).map((s) => s.sql);
    expect(cmds).toEqual(["HDEL", "HSET", "HSET"]);
    expect(result.statements[1]).toEqual({ sql: "HDEL", params: ["k", "b"] });
    expect(result.statements[2]).toEqual({ sql: "HSET", params: ["k", "a", "99"] });
    expect(result.statements[3]).toEqual({ sql: "HSET", params: ["k", "c", "3"] });
  });
});

describe("buildKeyStatements — list", () => {
  const baseColumns = [col("element")];

  function loaded(elements: string[]) {
    return withListIndexColumn(
      baseColumns,
      elements.map((e) => [e]),
    );
  }

  it("edits an element with LSET at its row position", () => {
    const { columns, rows } = loaded(["a", "b", "c"]);
    const t = tracker(rows, columns).setCell(1, 1, "bb");
    const result = buildKeyStatements("0", "k", "list", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "LSET", params: ["k", 1, "bb"] }]);
  });

  it("deletes one row via a sentinel LSET followed by one LREM", () => {
    const { columns, rows } = loaded(["a", "b", "c"]);
    const t = tracker(rows, columns).deleteRow(1);
    const result = buildKeyStatements("0", "k", "list", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const cmds = result.statements.slice(1);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].sql).toBe("LSET");
    expect(cmds[0].params[0]).toBe("k");
    expect(cmds[0].params[1]).toBe(1);
    const sentinel = cmds[0].params[2];
    expect(typeof sentinel).toBe("string");
    expect(cmds[1]).toEqual({ sql: "LREM", params: ["k", 0, sentinel] });
  });

  it("appends new elements with RPUSH", () => {
    const { columns, rows } = loaded(["a"]);
    const { tracker: t1, rowIndex } = tracker(rows, columns).insertRow();
    const t2 = t1.setCell(rowIndex, 1, "b");
    const result = buildKeyStatements("0", "k", "list", rows, t2, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "RPUSH", params: ["k", "b"] }]);
  });

  it("rejects a blank element", () => {
    const { columns, rows } = loaded(["a"]);
    const t = tracker(rows, columns).setCell(0, 1, null);
    const result = buildKeyStatements("0", "k", "list", rows, t, columns);
    expect(result).toEqual({ ok: false, error: "Element value is required" });
  });

  it("emits every LSET (edits and delete sentinels) before the single LREM, then RPUSH last", () => {
    const { columns, rows } = loaded(["a", "b", "c"]);
    // Delete row 0, edit row 2, insert a new element — all in one submit.
    const t0 = tracker(rows, columns).deleteRow(0).setCell(2, 1, "cc");
    const { tracker: t1, rowIndex } = t0.insertRow();
    const t2 = t1.setCell(rowIndex, 1, "d");
    const result = buildKeyStatements("0", "k", "list", rows, t2, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const cmds = result.statements.slice(1);
    // LSET (edit at row 2) and LSET (delete sentinel at row 0) both precede the LREM; the
    // original position 2 is still valid at that point because nothing has been removed yet.
    expect(cmds[0]).toEqual({ sql: "LSET", params: ["k", 2, "cc"] });
    expect(cmds[1].sql).toBe("LSET");
    expect(cmds[1].params.slice(0, 2)).toEqual(["k", 0]);
    expect(cmds[2].sql).toBe("LREM");
    expect(cmds[3]).toEqual({ sql: "RPUSH", params: ["k", "d"] });
  });
});

describe("buildKeyStatements — set", () => {
  const columns = [col("member")];
  const rows: CellValue[][] = [["a"], ["b"]];

  it("deletes a member with SREM", () => {
    const t = tracker(rows, columns).deleteRow(1);
    const result = buildKeyStatements("0", "k", "set", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "SREM", params: ["k", "b"] }]);
  });

  it("renames a member with SREM(old) + SADD(new)", () => {
    const t = tracker(rows, columns).setCell(0, 0, "aa");
    const result = buildKeyStatements("0", "k", "set", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([
      { sql: "SREM", params: ["k", "a"] },
      { sql: "SADD", params: ["k", "aa"] },
    ]);
  });

  it("inserts a new member with SADD", () => {
    const { tracker: t1, rowIndex } = tracker(rows, columns).insertRow();
    const t2 = t1.setCell(rowIndex, 0, "c");
    const result = buildKeyStatements("0", "k", "set", rows, t2, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "SADD", params: ["k", "c"] }]);
  });

  it("rejects a blank member", () => {
    const { tracker: t1, rowIndex } = tracker(rows, columns).insertRow();
    const t2 = t1.setCell(rowIndex, 0, "");
    const result = buildKeyStatements("0", "k", "set", rows, t2, columns);
    expect(result).toEqual({ ok: false, error: "Member is required" });
  });
});

describe("buildKeyStatements — zset", () => {
  const columns = [col("member"), col("score")];
  const rows: CellValue[][] = [
    ["a", "1"],
    ["b", "2"],
  ];

  it("deletes a member with ZREM", () => {
    const t = tracker(rows, columns).deleteRow(1);
    const result = buildKeyStatements("0", "k", "zset", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "ZREM", params: ["k", "b"] }]);
  });

  it("updates only the score with a plain ZADD", () => {
    const t = tracker(rows, columns).setCell(0, 1, "9");
    const result = buildKeyStatements("0", "k", "zset", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "ZADD", params: ["k", 9, "a"] }]);
  });

  it("renames a member with ZREM(old) + ZADD(score, new)", () => {
    const t = tracker(rows, columns).setCell(0, 0, "aa");
    const result = buildKeyStatements("0", "k", "zset", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([
      { sql: "ZREM", params: ["k", "a"] },
      { sql: "ZADD", params: ["k", 1, "aa"] },
    ]);
  });

  it("inserts a new member with a numeric score", () => {
    const { tracker: t1, rowIndex } = tracker(rows, columns).insertRow();
    const t2 = t1.setCell(rowIndex, 0, "c").setCell(rowIndex, 1, "5");
    const result = buildKeyStatements("0", "k", "zset", rows, t2, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "ZADD", params: ["k", 5, "c"] }]);
  });

  it("rejects a non-numeric score", () => {
    const t = tracker(rows, columns).setCell(0, 1, "not-a-number");
    const result = buildKeyStatements("0", "k", "zset", rows, t, columns);
    expect(result).toEqual({ ok: false, error: "Score must be a number" });
  });
});

describe("buildKeyStatements — stream", () => {
  const columns = [col("id"), col("fields")];
  const rows: CellValue[][] = [
    ["1-1", "a b"],
    ["2-1", "c d"],
  ];

  it("deletes an entry with XDEL, ignoring cell edits", () => {
    const t = tracker(rows, columns).deleteRow(0);
    const result = buildKeyStatements("0", "k", "stream", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements.slice(1)).toEqual([{ sql: "XDEL", params: ["k", "1-1"] }]);
  });
});

describe("buildKeyStatements — unknown type", () => {
  it("produces no commands beyond SELECT", () => {
    const columns = [col("value")];
    const rows: CellValue[][] = [["x"]];
    const t = tracker(rows, columns);
    const result = buildKeyStatements("0", "k", "none", rows, t, columns);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.statements).toEqual([{ sql: "SELECT", params: ["0"] }]);
  });
});
