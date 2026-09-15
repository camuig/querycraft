import { describe, expect, it } from "vitest";
import type { CellValue, ColumnMeta } from "../../api/types";
import { ChangeTracker } from "../changeTracker";

function col(name: string, opts: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    table: "t",
    database: "db",
    typeName: "VARCHAR",
    unsigned: false,
    nullable: true,
    primaryKey: false,
    binary: false,
    ...opts,
  };
}

const columns: ColumnMeta[] = [
  col("id", { primaryKey: true, nullable: false, typeName: "INT" }),
  col("name"),
  col("email"),
];

const pk = ["id"];

const rows: CellValue[][] = [
  [1, "Alice", "alice@example.com"],
  [2, "Bob", "bob@example.com"],
];

describe("setCell / isModified", () => {
  it("setCell marks the cell as modified", () => {
    const t = new ChangeTracker(rows, columns, pk);
    const t2 = t.setCell(0, 1, "Alicia");
    expect(t2.isModified(0, 1)).toBe(true);
    expect(t2.getValue(0, 1)).toBe("Alicia");
    // the original instance is not mutated
    expect(t.isModified(0, 1)).toBe(false);
    expect(t.getValue(0, 1)).toBe("Alice");
  });

  it("setCell with the same value as the original is not considered a modification", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 1, "Alice");
    expect(t.isModified(0, 1)).toBe(false);
  });
});

describe("revertCell", () => {
  it("reverts a single modified cell", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 1, "Alicia").setCell(0, 2, "x@y.z");
    const t2 = t.revertCell(0, 1);
    expect(t2.isModified(0, 1)).toBe(false);
    expect(t2.getValue(0, 1)).toBe("Alice");
    expect(t2.isModified(0, 2)).toBe(true);
  });
});

describe("revertAll", () => {
  it("reverts all changes (edits, deletes, inserts)", () => {
    const t0 = new ChangeTracker(rows, columns, pk);
    const t1 = t0.setCell(0, 1, "Alicia").deleteRow(1);
    const { tracker: t2 } = t1.insertRow();
    expect(t2.hasChanges).toBe(true);

    const t3 = t2.revertAll();
    expect(t3.hasChanges).toBe(false);
    expect(t3.rows).toEqual(rows);
  });
});

describe("deleteRow / undeleteRow", () => {
  it("marks a row as deleted and clears the mark", () => {
    const t = new ChangeTracker(rows, columns, pk);
    const t2 = t.deleteRow(1);
    expect(t2.isDeleted(1)).toBe(true);
    expect(t2.isDeleted(0)).toBe(false);

    const t3 = t2.undeleteRow(1);
    expect(t3.isDeleted(1)).toBe(false);
  });
});

describe("insertRow", () => {
  it("appends a row at the end with all nulls and marks it inserted", () => {
    const t = new ChangeTracker(rows, columns, pk);
    const { tracker: t2, rowIndex } = t.insertRow();
    expect(rowIndex).toBe(2);
    expect(t2.isInserted(2)).toBe(true);
    expect(t2.rows).toHaveLength(3);
    expect(t2.rows[2]).toEqual([null, null, null]);
    expect(t2.getValue(2, 0)).toBeNull();
  });
});

describe("buildStatements — UPDATE", () => {
  it("single modified column", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 1, "Alicia");
    const stmts = t.buildStatements("db", "t");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toEqual({
      sql: "UPDATE `db`.`t` SET `name`=? WHERE `id`=?",
      params: ["Alicia", 1],
    });
  });

  it("multiple modified columns in a single SET", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 1, "Alicia").setCell(0, 2, "a@b.c");
    const stmts = t.buildStatements("db", "t");
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toBe("UPDATE `db`.`t` SET `name`=?, `email`=? WHERE `id`=?");
    expect(stmts[0].params).toEqual(["Alicia", "a@b.c", 1]);
  });

  it("WHERE with multiple pk columns", () => {
    const cols2: ColumnMeta[] = [col("a", { primaryKey: true }), col("b", { primaryKey: true }), col("v")];
    const rows2: CellValue[][] = [[1, 2, "x"]];
    const t = new ChangeTracker(rows2, cols2, ["a", "b"]).setCell(0, 2, "y");
    const stmts = t.buildStatements(null, "t2");
    expect(stmts[0]).toEqual({
      sql: "UPDATE `t2` SET `v`=? WHERE `a`=? AND `b`=?",
      params: ["y", 1, 2],
    });
  });

  it("WHERE with pk = NULL in the original row", () => {
    const rows2: CellValue[][] = [[null, "Alice", "a@b.c"]];
    const t = new ChangeTracker(rows2, columns, pk).setCell(0, 1, "Alicia");
    const stmts = t.buildStatements("db", "t");
    expect(stmts[0].sql).toBe("UPDATE `db`.`t` SET `name`=? WHERE `id`IS NULL");
    expect(stmts[0].params).toEqual(["Alicia"]);
  });

  it("modifying the pk column itself: WHERE uses the old value, SET the new one", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 0, 99);
    const stmts = t.buildStatements("db", "t");
    expect(stmts[0]).toEqual({
      sql: "UPDATE `db`.`t` SET `id`=? WHERE `id`=?",
      params: [99, 1],
    });
  });
});

describe("buildStatements — DELETE", () => {
  it("builds DELETE using the original pk values", () => {
    const t = new ChangeTracker(rows, columns, pk).deleteRow(1);
    const stmts = t.buildStatements("db", "t");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toEqual({
      sql: "DELETE FROM `db`.`t` WHERE `id`=?",
      params: [2],
    });
  });
});

describe("buildStatements — INSERT", () => {
  it("partially filled new row: only non-null columns", () => {
    const t0 = new ChangeTracker(rows, columns, pk);
    const { tracker: t1, rowIndex } = t0.insertRow();
    const t2 = t1.setCell(rowIndex, 1, "Carol");
    const stmts = t2.buildStatements("db", "t");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toEqual({
      sql: "INSERT INTO `db`.`t` (`name`) VALUES (?)",
      params: ["Carol"],
    });
  });

  it("completely empty new row", () => {
    const t0 = new ChangeTracker(rows, columns, pk);
    const { tracker: t1 } = t0.insertRow();
    const stmts = t1.buildStatements("db", "t");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toEqual({
      sql: "INSERT INTO `db`.`t` () VALUES ()",
      params: [],
    });
  });
});

describe("insert then delete", () => {
  it("is fully excluded from buildStatements", () => {
    const t0 = new ChangeTracker(rows, columns, pk);
    const { tracker: t1, rowIndex } = t0.insertRow();
    const t2 = t1.setCell(rowIndex, 1, "Carol").deleteRow(rowIndex);
    const stmts = t2.buildStatements("db", "t");
    expect(stmts).toEqual([]);
  });
});

describe("DELETE -> UPDATE -> INSERT order", () => {
  it("produces statements in the correct order in a single call", () => {
    const t0 = new ChangeTracker(rows, columns, pk);
    const t1 = t0.deleteRow(1).setCell(0, 1, "Alicia");
    const { tracker: t2 } = t1.insertRow();
    const t3 = t2.setCell(2, 1, "Carol");

    const stmts = t3.buildStatements("db", "t");
    expect(stmts).toHaveLength(3);
    expect(stmts[0].sql).toMatch(/^DELETE FROM/);
    expect(stmts[1].sql).toMatch(/^UPDATE/);
    expect(stmts[2].sql).toMatch(/^INSERT INTO/);
  });
});

describe("missing pkColumns", () => {
  it("throws on update without pkColumns", () => {
    const t = new ChangeTracker(rows, columns, []).setCell(0, 1, "Alicia");
    expect(() => t.buildStatements("db", "t")).toThrow();
  });

  it("throws on delete without pkColumns", () => {
    const t = new ChangeTracker(rows, columns, []).deleteRow(0);
    expect(() => t.buildStatements("db", "t")).toThrow();
  });

  it("does not throw when pkColumns is empty but only insert rows changed", () => {
    const t0 = new ChangeTracker(rows, columns, []);
    const { tracker: t1 } = t0.insertRow();
    const t2 = t1.setCell(2, 1, "Carol");
    expect(() => t2.buildStatements("db", "t")).not.toThrow();
  });
});
