import { describe, expect, it } from "vitest";
import type { CellValue, ColumnMeta } from "../../api/types";
import { formatCell, isNumericType, rowsToClipboardText, toSqlInserts, toTsv } from "../format";

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

describe("rowsToClipboardText", () => {
  it("quotes CSV fields with commas, quotes and newlines and leaves null empty", () => {
    const rows: CellValue[][] = [
      ["a,b", 'say "hi"'],
      ["line1\nline2", null],
    ];
    expect(rowsToClipboardText(columns, rows, "csv", true)).toBe('id,name\n"a,b","say ""hi"""\n"line1\nline2",');
  });

  it("plain values are not quoted and headers are optional", () => {
    expect(rowsToClipboardText(columns, [[1, "Alice"]], "csv", false)).toBe("1,Alice");
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

describe("toSqlInserts", () => {
  it("escapes special characters and uses qualify with database", () => {
    const rows: CellValue[][] = [[1, "O'Brien"]];
    const sql = toSqlInserts("mydb", "users", columns, rows, "mysql");
    expect(sql).toBe("INSERT INTO `mydb`.`users` (`id`, `name`) VALUES (1, 'O\\'Brien');");
  });

  it("qualify with database=null does not add a database prefix", () => {
    const rows: CellValue[][] = [[1, "Alice"]];
    const sql = toSqlInserts(null, "users", columns, rows, "mysql");
    expect(sql).toBe("INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice');");
  });

  it("each row is a separate INSERT, separated by a newline", () => {
    const rows: CellValue[][] = [
      [1, "Alice"],
      [2, null],
    ];
    const sql = toSqlInserts("db", "t", columns, rows, "mysql");
    expect(sql.split("\n")).toEqual([
      "INSERT INTO `db`.`t` (`id`, `name`) VALUES (1, 'Alice');",
      "INSERT INTO `db`.`t` (`id`, `name`) VALUES (2, NULL);",
    ]);
  });

  it("uses double-quoted identifiers for sqlite", () => {
    const rows: CellValue[][] = [[1, "it's"]];
    const sql = toSqlInserts(null, "t", columns, rows, "sqlite");
    expect(sql).toBe('INSERT INTO "t" ("id", "name") VALUES (1, \'it\'\'s\');');
  });
});

describe("isNumericType", () => {
  it("recognizes MySQL/MariaDB numeric types", () => {
    for (const t of ["INT", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT", "DECIMAL", "FLOAT", "DOUBLE", "YEAR"]) {
      expect(isNumericType(t)).toBe(true);
    }
  });

  it("recognizes PostgreSQL numeric types", () => {
    for (const t of ["INT2", "INT4", "INT8", "FLOAT4", "FLOAT8", "NUMERIC", "OID", "SERIAL", "BIGSERIAL"]) {
      expect(isNumericType(t)).toBe(true);
    }
  });

  it("recognizes ClickHouse numeric types, case-insensitively", () => {
    for (const t of ["UInt8", "UInt256", "Int8", "Int256", "Float32", "Float64", "Decimal32", "BFloat16"]) {
      expect(isNumericType(t)).toBe(true);
    }
  });

  it("recognizes SQLite numeric types", () => {
    for (const t of ["INTEGER", "REAL", "NUMERIC"]) {
      expect(isNumericType(t)).toBe(true);
    }
  });

  it("strips a (...) suffix before matching", () => {
    expect(isNumericType("DECIMAL(10,2)")).toBe(true);
    expect(isNumericType("Decimal32(9)")).toBe(true);
  });

  it("returns false for non-numeric types and empty input", () => {
    expect(isNumericType("VARCHAR")).toBe(false);
    expect(isNumericType("TEXT")).toBe(false);
    expect(isNumericType("DATETIME")).toBe(false);
    expect(isNumericType(null)).toBe(false);
    expect(isNumericType(undefined)).toBe(false);
  });
});
