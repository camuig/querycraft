import { describe, expect, it } from "vitest";
import { buildSelect, qualify, quoteIdent, sqlLiteral } from "../sqlBuilder";

describe("quoteIdent", () => {
  it("wraps a name in backticks for mysql/mariadb/clickhouse", () => {
    expect(quoteIdent("users", "mysql")).toBe("`users`");
    expect(quoteIdent("users", "mariadb")).toBe("`users`");
    expect(quoteIdent("users", "clickhouse")).toBe("`users`");
  });

  it("doubles internal backticks", () => {
    expect(quoteIdent("weird`name", "mysql")).toBe("`weird``name`");
  });

  it("wraps a name in double quotes for postgres/sqlite", () => {
    expect(quoteIdent("users", "postgres")).toBe('"users"');
    expect(quoteIdent("users", "sqlite")).toBe('"users"');
  });

  it("doubles internal double quotes", () => {
    expect(quoteIdent('weird"name', "postgres")).toBe('"weird""name"');
  });

  it("quotes a dotted name as two parts for mssql (dottedIdentifier)", () => {
    expect(quoteIdent("dbo.Orders", "mssql")).toBe('"dbo"."Orders"');
  });

  it("quotes a name without a dot as a single identifier for mssql", () => {
    expect(quoteIdent("Orders", "mssql")).toBe('"Orders"');
  });

  it("doubles internal double quotes in each part of a dotted mssql name", () => {
    expect(quoteIdent('dbo.weird"name', "mssql")).toBe('"dbo"."weird""name"');
  });

  it("non-mssql engines quote a dotted name as a single identifier (dottedIdentifier off)", () => {
    expect(quoteIdent("dbo.Orders", "postgres")).toBe('"dbo.Orders"');
  });
});

describe("qualify", () => {
  it("returns `db`.`table` when db is set", () => {
    expect(qualify("mydb", "users", "mysql")).toBe("`mydb`.`users`");
  });

  it("returns `table` when db === null", () => {
    expect(qualify(null, "users", "mysql")).toBe("`users`");
  });

  it('returns "db"."table" for postgres', () => {
    expect(qualify("mydb", "users", "postgres")).toBe('"mydb"."users"');
  });

  it("returns a 3-part quoted name for mssql when table is schema.table", () => {
    expect(qualify("qc_test", "sales.Invoice", "mssql")).toBe('"qc_test"."sales"."Invoice"');
  });

  it("returns a 2-part quoted name for mssql when table has no schema", () => {
    expect(qualify("qc_test", "Orders", "mssql")).toBe('"qc_test"."Orders"');
  });
});

describe("sqlLiteral", () => {
  it("null -> NULL", () => {
    expect(sqlLiteral(null, "mysql")).toBe("NULL");
  });

  it("number -> as is", () => {
    expect(sqlLiteral(42, "mysql")).toBe("42");
    expect(sqlLiteral(-3.5, "mysql")).toBe("-3.5");
  });

  it("boolean -> 1/0 for mysql/mariadb/clickhouse/sqlite", () => {
    expect(sqlLiteral(true, "mysql")).toBe("1");
    expect(sqlLiteral(false, "mysql")).toBe("0");
    expect(sqlLiteral(true, "clickhouse")).toBe("1");
    expect(sqlLiteral(true, "sqlite")).toBe("1");
  });

  it("boolean -> TRUE/FALSE for postgres", () => {
    expect(sqlLiteral(true, "postgres")).toBe("TRUE");
    expect(sqlLiteral(false, "postgres")).toBe("FALSE");
  });

  it("string -> single-quoted", () => {
    expect(sqlLiteral("hello", "mysql")).toBe("'hello'");
  });

  it("escapes a single quote, double quote and backslash for backslash-escaping engines", () => {
    expect(sqlLiteral(`it's a "test" \\`, "mysql")).toBe(`'it\\'s a \\"test\\" \\\\'`);
  });

  it("escapes \\n, \\r, NUL and Ctrl-Z for backslash-escaping engines", () => {
    expect(sqlLiteral("a\nb\rc\0d\x1a e", "mysql")).toBe("'a\\nb\\rc\\0d\\Z e'");
  });

  it("postgres/sqlite only double single quotes, backslashes are untouched", () => {
    expect(sqlLiteral("it's a \\test\\", "postgres")).toBe("'it''s a \\test\\'");
    expect(sqlLiteral("it's a \\test\\", "sqlite")).toBe("'it''s a \\test\\'");
  });
});

describe("buildSelect", () => {
  it("minimal SELECT without where/orderBy/limit/offset", () => {
    expect(buildSelect({ database: "mydb", table: "users", kind: "mysql" })).toBe("SELECT * FROM `mydb`.`users`");
  });

  it("SELECT without database", () => {
    expect(buildSelect({ database: null, table: "users", kind: "mysql" })).toBe("SELECT * FROM `users`");
  });

  it("adds WHERE when where is non-empty", () => {
    expect(buildSelect({ database: "db", table: "t", kind: "mysql", where: "id = 1" })).toBe(
      "SELECT * FROM `db`.`t` WHERE (id = 1)",
    );
  });

  it("does not add WHERE when where is empty or blank", () => {
    expect(buildSelect({ database: "db", table: "t", kind: "mysql", where: "" })).toBe("SELECT * FROM `db`.`t`");
    expect(buildSelect({ database: "db", table: "t", kind: "mysql", where: "   " })).toBe("SELECT * FROM `db`.`t`");
  });

  it("adds ORDER BY with multiple columns and directions", () => {
    const sql = buildSelect({
      database: "db",
      table: "t",
      kind: "mysql",
      orderBy: [
        { column: "a", dir: "asc" },
        { column: "b", dir: "desc" },
      ],
    });
    expect(sql).toBe("SELECT * FROM `db`.`t` ORDER BY `a` ASC, `b` DESC");
  });

  it("adds LIMIT and OFFSET when set and > 0", () => {
    expect(buildSelect({ database: "db", table: "t", kind: "mysql", limit: 50, offset: 100 })).toBe(
      "SELECT * FROM `db`.`t` LIMIT 50 OFFSET 100",
    );
  });

  it("does not add LIMIT/OFFSET when they equal 0", () => {
    expect(buildSelect({ database: "db", table: "t", kind: "mysql", limit: 0, offset: 0 })).toBe(
      "SELECT * FROM `db`.`t`",
    );
  });

  it("combines where + orderBy + limit + offset together", () => {
    const sql = buildSelect({
      database: "db",
      table: "t",
      kind: "mysql",
      where: "x > 1",
      orderBy: [{ column: "x", dir: "asc" }],
      limit: 10,
      offset: 20,
    });
    expect(sql).toBe("SELECT * FROM `db`.`t` WHERE (x > 1) ORDER BY `x` ASC LIMIT 10 OFFSET 20");
  });

  it("quotes identifiers with double quotes for postgres, LIMIT/OFFSET stay the same", () => {
    const sql = buildSelect({
      database: "db",
      table: "t",
      kind: "postgres",
      where: "x > 1",
      orderBy: [{ column: "x", dir: "asc" }],
      limit: 10,
      offset: 20,
    });
    expect(sql).toBe('SELECT * FROM "db"."t" WHERE (x > 1) ORDER BY "x" ASC LIMIT 10 OFFSET 20');
  });

  it("mssql: no OFFSET/FETCH when neither limit nor offset is set", () => {
    expect(buildSelect({ database: "db", table: "t", kind: "mssql" })).toBe('SELECT * FROM "db"."t"');
  });

  it("mssql: OFFSET 0 ROWS FETCH NEXT n ROWS ONLY when only limit is set", () => {
    const sql = buildSelect({ database: "db", table: "t", kind: "mssql", limit: 50 });
    expect(sql).toBe('SELECT * FROM "db"."t" ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY');
  });

  it("mssql: falls back to ORDER BY (SELECT NULL) when paging without an explicit ORDER BY", () => {
    const sql = buildSelect({ database: "db", table: "t", kind: "mssql", limit: 50, offset: 100 });
    expect(sql).toBe('SELECT * FROM "db"."t" ORDER BY (SELECT NULL) OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY');
  });

  it("mssql: uses the explicit ORDER BY instead of the fallback when one is given", () => {
    const sql = buildSelect({
      database: "db",
      table: "t",
      kind: "mssql",
      orderBy: [{ column: "x", dir: "asc" }],
      limit: 50,
      offset: 100,
    });
    expect(sql).toBe('SELECT * FROM "db"."t" ORDER BY "x" ASC OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY');
  });

  it("mssql: offset without a limit emits OFFSET ROWS with no FETCH NEXT", () => {
    const sql = buildSelect({ database: "db", table: "t", kind: "mssql", offset: 100 });
    expect(sql).toBe('SELECT * FROM "db"."t" ORDER BY (SELECT NULL) OFFSET 100 ROWS');
  });

  it("mssql: ORDER BY alone (no limit/offset) does not add OFFSET/FETCH", () => {
    const sql = buildSelect({
      database: "db",
      table: "t",
      kind: "mssql",
      orderBy: [{ column: "x", dir: "desc" }],
    });
    expect(sql).toBe('SELECT * FROM "db"."t" ORDER BY "x" DESC');
  });

  it("mssql: dotted table name qualifies to a 3-part name in the generated SELECT", () => {
    const sql = buildSelect({ database: "qc_test", table: "sales.Invoice", kind: "mssql", limit: 10 });
    expect(sql).toBe(
      'SELECT * FROM "qc_test"."sales"."Invoice" ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY',
    );
  });
});
