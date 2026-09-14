import { describe, expect, it } from "vitest";
import { buildSelect, qualify, quoteIdent, sqlLiteral } from "../sqlBuilder";

describe("quoteIdent", () => {
  it("оборачивает имя в обратные кавычки", () => {
    expect(quoteIdent("users")).toBe("`users`");
  });

  it("удваивает внутренние обратные кавычки", () => {
    expect(quoteIdent("weird`name")).toBe("`weird``name`");
  });
});

describe("qualify", () => {
  it("возвращает `db`.`table`, если db задан", () => {
    expect(qualify("mydb", "users")).toBe("`mydb`.`users`");
  });

  it("возвращает `table`, если db === null", () => {
    expect(qualify(null, "users")).toBe("`users`");
  });
});

describe("sqlLiteral", () => {
  it("null -> NULL", () => {
    expect(sqlLiteral(null)).toBe("NULL");
  });

  it("number -> как есть", () => {
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(-3.5)).toBe("-3.5");
  });

  it("boolean -> 1/0", () => {
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(false)).toBe("0");
  });

  it("string -> в одинарных кавычках", () => {
    expect(sqlLiteral("hello")).toBe("'hello'");
  });

  it("экранирует одинарную кавычку, двойную кавычку и бэкслеш", () => {
    expect(sqlLiteral(`it's a "test" \\`)).toBe(`'it\\'s a \\"test\\" \\\\'`);
  });

  it("экранирует \\n, \\r, NUL и Ctrl-Z", () => {
    expect(sqlLiteral("a\nb\rc\0d\x1a e")).toBe("'a\\nb\\rc\\0d\\Z e'");
  });
});

describe("buildSelect", () => {
  it("минимальный SELECT без where/orderBy/limit/offset", () => {
    expect(buildSelect({ database: "mydb", table: "users" })).toBe(
      "SELECT * FROM `mydb`.`users`",
    );
  });

  it("SELECT без database", () => {
    expect(buildSelect({ database: null, table: "users" })).toBe("SELECT * FROM `users`");
  });

  it("добавляет WHERE, если where непустой", () => {
    expect(buildSelect({ database: "db", table: "t", where: "id = 1" })).toBe(
      "SELECT * FROM `db`.`t` WHERE (id = 1)",
    );
  });

  it("не добавляет WHERE, если where пустой или из пробелов", () => {
    expect(buildSelect({ database: "db", table: "t", where: "" })).toBe(
      "SELECT * FROM `db`.`t`",
    );
    expect(buildSelect({ database: "db", table: "t", where: "   " })).toBe(
      "SELECT * FROM `db`.`t`",
    );
  });

  it("добавляет ORDER BY с несколькими колонками и направлениями", () => {
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

  it("добавляет LIMIT и OFFSET, если заданы и > 0", () => {
    expect(buildSelect({ database: "db", table: "t", limit: 50, offset: 100 })).toBe(
      "SELECT * FROM `db`.`t` LIMIT 50 OFFSET 100",
    );
  });

  it("не добавляет LIMIT/OFFSET, если равны 0", () => {
    expect(buildSelect({ database: "db", table: "t", limit: 0, offset: 0 })).toBe(
      "SELECT * FROM `db`.`t`",
    );
  });

  it("собирает where + orderBy + limit + offset вместе", () => {
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
