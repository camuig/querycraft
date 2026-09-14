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
  it("setCell помечает ячейку как изменённую", () => {
    const t = new ChangeTracker(rows, columns, pk);
    const t2 = t.setCell(0, 1, "Alicia");
    expect(t2.isModified(0, 1)).toBe(true);
    expect(t2.getValue(0, 1)).toBe("Alicia");
    // исходный инстанс не мутирован
    expect(t.isModified(0, 1)).toBe(false);
    expect(t.getValue(0, 1)).toBe("Alice");
  });

  it("setCell тем же значением, что исходное, не считается модификацией", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 1, "Alice");
    expect(t.isModified(0, 1)).toBe(false);
  });
});

describe("revertCell", () => {
  it("откатывает одну изменённую ячейку", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 1, "Alicia").setCell(0, 2, "x@y.z");
    const t2 = t.revertCell(0, 1);
    expect(t2.isModified(0, 1)).toBe(false);
    expect(t2.getValue(0, 1)).toBe("Alice");
    expect(t2.isModified(0, 2)).toBe(true);
  });
});

describe("revertAll", () => {
  it("откатывает все изменения (edits, deletes, inserts)", () => {
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
  it("помечает строку удалённой и снимает пометку", () => {
    const t = new ChangeTracker(rows, columns, pk);
    const t2 = t.deleteRow(1);
    expect(t2.isDeleted(1)).toBe(true);
    expect(t2.isDeleted(0)).toBe(false);

    const t3 = t2.undeleteRow(1);
    expect(t3.isDeleted(1)).toBe(false);
  });
});

describe("insertRow", () => {
  it("добавляет строку в конец со всеми null и помечает inserted", () => {
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
  it("одна изменённая колонка", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 1, "Alicia");
    const stmts = t.buildStatements("db", "t");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toEqual({
      sql: "UPDATE `db`.`t` SET `name`=? WHERE `id`=?",
      params: ["Alicia", 1],
    });
  });

  it("несколько изменённых колонок в одном SET", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 1, "Alicia").setCell(0, 2, "a@b.c");
    const stmts = t.buildStatements("db", "t");
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toBe("UPDATE `db`.`t` SET `name`=?, `email`=? WHERE `id`=?");
    expect(stmts[0].params).toEqual(["Alicia", "a@b.c", 1]);
  });

  it("WHERE с несколькими pk-колонками", () => {
    const cols2: ColumnMeta[] = [
      col("a", { primaryKey: true }),
      col("b", { primaryKey: true }),
      col("v"),
    ];
    const rows2: CellValue[][] = [[1, 2, "x"]];
    const t = new ChangeTracker(rows2, cols2, ["a", "b"]).setCell(0, 2, "y");
    const stmts = t.buildStatements(null, "t2");
    expect(stmts[0]).toEqual({
      sql: "UPDATE `t2` SET `v`=? WHERE `a`=? AND `b`=?",
      params: ["y", 1, 2],
    });
  });

  it("WHERE с pk = NULL в исходной строке", () => {
    const rows2: CellValue[][] = [[null, "Alice", "a@b.c"]];
    const t = new ChangeTracker(rows2, columns, pk).setCell(0, 1, "Alicia");
    const stmts = t.buildStatements("db", "t");
    expect(stmts[0].sql).toBe("UPDATE `db`.`t` SET `name`=? WHERE `id`IS NULL");
    expect(stmts[0].params).toEqual(["Alicia"]);
  });

  it("изменение самой pk-колонки: WHERE по старому значению, SET по новому", () => {
    const t = new ChangeTracker(rows, columns, pk).setCell(0, 0, 99);
    const stmts = t.buildStatements("db", "t");
    expect(stmts[0]).toEqual({
      sql: "UPDATE `db`.`t` SET `id`=? WHERE `id`=?",
      params: [99, 1],
    });
  });
});

describe("buildStatements — DELETE", () => {
  it("строит DELETE по оригинальным pk-значениям", () => {
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
  it("частично заполненная новая строка: только не-null колонки", () => {
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

  it("полностью пустая новая строка", () => {
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

describe("insert затем delete", () => {
  it("исключается из buildStatements полностью", () => {
    const t0 = new ChangeTracker(rows, columns, pk);
    const { tracker: t1, rowIndex } = t0.insertRow();
    const t2 = t1.setCell(rowIndex, 1, "Carol").deleteRow(rowIndex);
    const stmts = t2.buildStatements("db", "t");
    expect(stmts).toEqual([]);
  });
});

describe("порядок DELETE -> UPDATE -> INSERT", () => {
  it("формирует statements в правильном порядке за один вызов", () => {
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

describe("отсутствие pkColumns", () => {
  it("бросает исключение при update без pkColumns", () => {
    const t = new ChangeTracker(rows, columns, []).setCell(0, 1, "Alicia");
    expect(() => t.buildStatements("db", "t")).toThrow();
  });

  it("бросает исключение при delete без pkColumns", () => {
    const t = new ChangeTracker(rows, columns, []).deleteRow(0);
    expect(() => t.buildStatements("db", "t")).toThrow();
  });

  it("не бросает исключение, если pkColumns пуст, но менялись только insert-строки", () => {
    const t0 = new ChangeTracker(rows, columns, []);
    const { tracker: t1 } = t0.insertRow();
    const t2 = t1.setCell(2, 1, "Carol");
    expect(() => t2.buildStatements("db", "t")).not.toThrow();
  });
});
