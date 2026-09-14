import { describe, expect, it } from "vitest";
import type { CellValue, ColumnMeta } from "../../api/types";
import { formatCell, toCsv, toJson, toSqlInserts, toTsv } from "../format";

function col(name: string): ColumnMeta {
  return {
    name,
    table: "t",
    database: "db",
    typeName: "VARCHAR",
    unsigned: false,
    nullable: true,
    primaryKey: false,
    binary: false,
  };
}

const columns: ColumnMeta[] = [col("id"), col("name")];

describe("formatCell", () => {
  it("null -> пустая строка", () => {
    expect(formatCell(null)).toBe("");
  });

  it("number -> String(v)", () => {
    expect(formatCell(42)).toBe("42");
    expect(formatCell(3.14)).toBe("3.14");
  });

  it("boolean -> String(v)", () => {
    expect(formatCell(true)).toBe("true");
    expect(formatCell(false)).toBe("false");
  });

  it("строка возвращается как есть, если короче лимита", () => {
    expect(formatCell("hello")).toBe("hello");
  });

  it("длинная строка обрезается до 1000 символов с добавлением …", () => {
    const long = "a".repeat(1500);
    const result = formatCell(long);
    expect(result.length).toBe(1001);
    expect(result.endsWith("…")).toBe(true);
    expect(result.slice(0, 1000)).toBe("a".repeat(1000));
  });

  it("строка ровно 1000 символов не обрезается", () => {
    const s = "a".repeat(1000);
    expect(formatCell(s)).toBe(s);
  });
});

describe("toCsv", () => {
  it("экранирует поля с запятой, кавычками и переводом строки", () => {
    const rows: CellValue[][] = [["a,b", 'say "hi"'], ["line1\nline2", null]];
    const csv = toCsv(columns, rows);
    expect(csv).toBe('id,name\n"a,b","say ""hi"""\n"line1\nline2",');
  });

  it("null -> пустое поле", () => {
    const csv = toCsv(columns, [[null, null]]);
    expect(csv).toBe("id,name\n,");
  });

  it("простые значения без спецсимволов не оборачиваются в кавычки", () => {
    const csv = toCsv(columns, [[1, "Alice"]]);
    expect(csv).toBe("id,name\n1,Alice");
  });
});

describe("toTsv", () => {
  it("заменяет табы и переводы строк на пробел", () => {
    const rows: CellValue[][] = [["a\tb", "c\nd\re"]];
    const tsv = toTsv(columns, rows);
    expect(tsv).toBe("id\tname\na b\tc d e");
  });

  it("null -> пустая строка", () => {
    const tsv = toTsv(columns, [[null, "x"]]);
    expect(tsv).toBe("id\tname\n\tx");
  });
});

describe("toJson", () => {
  it("строит массив объектов {colName: value}", () => {
    const rows: CellValue[][] = [
      [1, "Alice"],
      [2, null],
    ];
    const json = toJson(columns, rows);
    expect(JSON.parse(json)).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: null },
    ]);
    // отступ 2 пробела
    expect(json).toContain('\n  {\n    "id": 1');
  });
});

describe("toSqlInserts", () => {
  it("экранирует спецсимволы и использует qualify с database", () => {
    const rows: CellValue[][] = [[1, "O'Brien"]];
    const sql = toSqlInserts("mydb", "users", columns, rows);
    expect(sql).toBe("INSERT INTO `mydb`.`users` (`id`, `name`) VALUES (1, 'O\\'Brien');");
  });

  it("qualify с database=null не добавляет префикс базы", () => {
    const rows: CellValue[][] = [[1, "Alice"]];
    const sql = toSqlInserts(null, "users", columns, rows);
    expect(sql).toBe("INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice');");
  });

  it("каждая строка — отдельный INSERT, разделены переводом строки", () => {
    const rows: CellValue[][] = [
      [1, "Alice"],
      [2, null],
    ];
    const sql = toSqlInserts("db", "t", columns, rows);
    expect(sql.split("\n")).toEqual([
      "INSERT INTO `db`.`t` (`id`, `name`) VALUES (1, 'Alice');",
      "INSERT INTO `db`.`t` (`id`, `name`) VALUES (2, NULL);",
    ]);
  });
});
