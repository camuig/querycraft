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
  it("null -> empty string", () => {
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

  it("string is returned as is when shorter than the limit", () => {
    expect(formatCell("hello")).toBe("hello");
  });

  it("long string is truncated to 1000 characters with … appended", () => {
    const long = "a".repeat(1500);
    const result = formatCell(long);
    expect(result.length).toBe(1001);
    expect(result.endsWith("…")).toBe(true);
    expect(result.slice(0, 1000)).toBe("a".repeat(1000));
  });

  it("string of exactly 1000 characters is not truncated", () => {
    const s = "a".repeat(1000);
    expect(formatCell(s)).toBe(s);
  });
});

describe("toCsv", () => {
  it("escapes fields with commas, quotes and newlines", () => {
    const rows: CellValue[][] = [["a,b", 'say "hi"'], ["line1\nline2", null]];
    const csv = toCsv(columns, rows);
    expect(csv).toBe('id,name\n"a,b","say ""hi"""\n"line1\nline2",');
  });

  it("null -> empty field", () => {
    const csv = toCsv(columns, [[null, null]]);
    expect(csv).toBe("id,name\n,");
  });

  it("plain values without special characters are not quoted", () => {
    const csv = toCsv(columns, [[1, "Alice"]]);
    expect(csv).toBe("id,name\n1,Alice");
  });
});

describe("toTsv", () => {
  it("replaces tabs and newlines with a space", () => {
    const rows: CellValue[][] = [["a\tb", "c\nd\re"]];
    const tsv = toTsv(columns, rows);
    expect(tsv).toBe("id\tname\na b\tc d e");
  });

  it("null -> empty string", () => {
    const tsv = toTsv(columns, [[null, "x"]]);
    expect(tsv).toBe("id\tname\n\tx");
  });
});

describe("toJson", () => {
  it("builds an array of {colName: value} objects", () => {
    const rows: CellValue[][] = [
      [1, "Alice"],
      [2, null],
    ];
    const json = toJson(columns, rows);
    expect(JSON.parse(json)).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: null },
    ]);
    // 2-space indent
    expect(json).toContain('\n  {\n    "id": 1');
  });
});

describe("toSqlInserts", () => {
  it("escapes special characters and uses qualify with database", () => {
    const rows: CellValue[][] = [[1, "O'Brien"]];
    const sql = toSqlInserts("mydb", "users", columns, rows);
    expect(sql).toBe("INSERT INTO `mydb`.`users` (`id`, `name`) VALUES (1, 'O\\'Brien');");
  });

  it("qualify with database=null does not add a database prefix", () => {
    const rows: CellValue[][] = [[1, "Alice"]];
    const sql = toSqlInserts(null, "users", columns, rows);
    expect(sql).toBe("INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice');");
  });

  it("each row is a separate INSERT, separated by a newline", () => {
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
