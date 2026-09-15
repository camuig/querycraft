import { describe, expect, it } from "vitest";
import { buildSelect, qualify, quoteIdent, sqlLiteral } from "../sqlBuilder";

describe("quoteIdent", () => {
  it("wraps a name in backticks", () => {
    expect(quoteIdent("users")).toBe("`users`");
  });

  it("doubles internal backticks", () => {
    expect(quoteIdent("weird`name")).toBe("`weird``name`");
  });
});

describe("qualify", () => {
  it("returns `db`.`table` when db is set", () => {
    expect(qualify("mydb", "users")).toBe("`mydb`.`users`");
  });

  it("returns `table` when db === null", () => {
    expect(qualify(null, "users")).toBe("`users`");
  });
});

describe("sqlLiteral", () => {
  it("null -> NULL", () => {
    expect(sqlLiteral(null)).toBe("NULL");
  });

  it("number -> as is", () => {
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(-3.5)).toBe("-3.5");
  });

  it("boolean -> 1/0", () => {
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(false)).toBe("0");
  });

  it("string -> single-quoted", () => {
    expect(sqlLiteral("hello")).toBe("'hello'");
  });

  it("escapes a single quote, double quote and backslash", () => {
    expect(sqlLiteral(`it's a "test" \\`)).toBe(`'it\\'s a \\"test\\" \\\\'`);
  });

  it("escapes \\n, \\r, NUL and Ctrl-Z", () => {
    expect(sqlLiteral("a\nb\rc\0d\x1a e")).toBe("'a\\nb\\rc\\0d\\Z e'");
  });
});

describe("buildSelect", () => {
  it("minimal SELECT without where/orderBy/limit/offset", () => {
    expect(buildSelect({ database: "mydb", table: "users" })).toBe(
      "SELECT * FROM `mydb`.`users`",
    );
  });

  it("SELECT without database", () => {
    expect(buildSelect({ database: null, table: "users" })).toBe("SELECT * FROM `users`");
  });

  it("adds WHERE when where is non-empty", () => {
    expect(buildSelect({ database: "db", table: "t", where: "id = 1" })).toBe(
      "SELECT * FROM `db`.`t` WHERE (id = 1)",
    );
  });

  it("does not add WHERE when where is empty or blank", () => {
    expect(buildSelect({ database: "db", table: "t", where: "" })).toBe(
      "SELECT * FROM `db`.`t`",
    );
    expect(buildSelect({ database: "db", table: "t", where: "   " })).toBe(
      "SELECT * FROM `db`.`t`",
    );
  });

  it("adds ORDER BY with multiple columns and directions", () => {
    const sql = buildSelect({
      database: "db",
      table: "t",
      orderBy: [
        { column: "a", dir: "asc" },
        { column: "b", dir: "desc" },
      ],
    });
    expect(sql).toBe("SELECT * FROM `db`.`t` ORDER BY `a` ASC, `b` DESC");
  });

  it("adds LIMIT and OFFSET when set and > 0", () => {
    expect(buildSelect({ database: "db", table: "t", limit: 50, offset: 100 })).toBe(
      "SELECT * FROM `db`.`t` LIMIT 50 OFFSET 100",
    );
  });

  it("does not add LIMIT/OFFSET when they equal 0", () => {
    expect(buildSelect({ database: "db", table: "t", limit: 0, offset: 0 })).toBe(
      "SELECT * FROM `db`.`t`",
    );
  });

  it("combines where + orderBy + limit + offset together", () => {
    const sql = buildSelect({
      database: "db",
      table: "t",
      where: "x > 1",
      orderBy: [{ column: "x", dir: "asc" }],
      limit: 10,
      offset: 20,
    });
    expect(sql).toBe("SELECT * FROM `db`.`t` WHERE (x > 1) ORDER BY `x` ASC LIMIT 10 OFFSET 20");
  });
});
