import { describe, expect, it } from "vitest";
import { splitStatements, statementAtCursor } from "../sqlSplit";

describe("splitStatements", () => {
  it("splits a simple string on ;", () => {
    const stmts = splitStatements("SELECT 1; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("skips empty statements between ;;", () => {
    const stmts = splitStatements("SELECT 1;;SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not split on ; inside single quotes", () => {
    const stmts = splitStatements("SELECT 'a;b'; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 'a;b'", "SELECT 2"]);
  });

  it("does not split on ; inside double quotes", () => {
    const stmts = splitStatements('SELECT "a;b"; SELECT 2;');
    expect(stmts.map((s) => s.sql)).toEqual(['SELECT "a;b"', "SELECT 2"]);
  });

  it("does not split on ; inside backtick identifiers", () => {
    const stmts = splitStatements("SELECT `a;b` FROM t; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT `a;b` FROM t", "SELECT 2"]);
  });

  it("supports backslash escaping inside a string", () => {
    const stmts = splitStatements("SELECT 'a\\'b;c'; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 'a\\'b;c'", "SELECT 2"]);
  });

  it("supports escaping via a doubled quote", () => {
    const stmts = splitStatements("SELECT 'a''b;c'; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 'a''b;c'", "SELECT 2"]);
  });

  it("-- comment (with a space after) does not split on ; inside itself", () => {
    const stmts = splitStatements("SELECT 1; -- comment; still comment\nSELECT 2;");
    // ';' inside the comment is ignored, so the comment stays part of the
    // same statement as the SELECT 2 that follows it.
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1", "-- comment; still comment\nSELECT 2"]);
  });

  it("does not treat --comment (no space) as a comment, ; after it is significant", () => {
    const stmts = splitStatements("SELECT 1--x\n;SELECT 2;");
    // "--x" without a space after -- is not a comment per MySQL rules,
    // so it is part of the statement up to the next ;
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1--x", "SELECT 2"]);
  });

  it("# comment does not split on ; inside itself", () => {
    const stmts = splitStatements("SELECT 1; # comment ; still\nSELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1", "# comment ; still\nSELECT 2"]);
  });

  it("block comment /* ... */ does not split on ; inside itself", () => {
    const stmts = splitStatements("SELECT 1; /* comment ; with semi */ SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1", "/* comment ; with semi */ SELECT 2"]);
  });

  it("supports DELIMITER // for a stored procedure", () => {
    const sql = [
      "DELIMITER //",
      "CREATE PROCEDURE p()",
      "BEGIN",
      "  SELECT 1;",
      "  SELECT 2;",
      "END //",
      "DELIMITER ;",
      "SELECT 3;",
    ].join("\n");

    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toBe("CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND");
    expect(stmts[1].sql).toBe("SELECT 3");
  });

  it("does not include the DELIMITER line in the result as a separate statement", () => {
    const stmts = splitStatements("DELIMITER $$\nSELECT 1$$\nDELIMITER ;\n");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1"]);
  });

  it("from/to point to offsets in the source (untrimmed) string", () => {
    const sql = "  SELECT 1  ;  SELECT 2;";
    const stmts = splitStatements(sql);
    expect(stmts[0].sql).toBe("SELECT 1");
    expect(sql.slice(stmts[0].from, stmts[0].to)).toBe("SELECT 1");
    expect(stmts[1].sql).toBe("SELECT 2");
    expect(sql.slice(stmts[1].from, stmts[1].to)).toBe("SELECT 2");
  });

  it("an empty string yields an empty result", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   \n\n  ")).toEqual([]);
  });

  it("a statement consisting only of comments is skipped", () => {
    const stmts = splitStatements("-- just a comment\n;\nSELECT 1;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1"]);
  });
});

describe("statementAtCursor", () => {
  const sql = "SELECT 1; SELECT 2; SELECT 3;";
  // indices: "SELECT 1" [0,8) ";"=8 " "=9 "SELECT 2" [10,18) ";"=18 " "=19 "SELECT 3" [20,28) ";"=28

  it("finds the statement when the cursor is in its middle", () => {
    const s = statementAtCursor(sql, 3);
    expect(s?.sql).toBe("SELECT 1");
  });

  it("finds the statement when the cursor is at its boundary (from)", () => {
    const s = statementAtCursor(sql, 0);
    expect(s?.sql).toBe("SELECT 1");
  });

  it("treats the cursor right after ; as still inside the previous statement", () => {
    const s = statementAtCursor(sql, 9); // right after the first ";"
    expect(s?.sql).toBe("SELECT 1");
  });

  it("treats the cursor in whitespace between statements as inside the previous one", () => {
    const s = statementAtCursor(sql, 19); // space between the second ";" and the third SELECT
    expect(s?.sql).toBe("SELECT 2");
  });

  it("returns null for an empty string", () => {
    expect(statementAtCursor("", 0)).toBeNull();
  });

  it("returns null when the cursor is before the first statement (no previous one)", () => {
    const s = statementAtCursor("   SELECT 1;", 1);
    expect(s).toBeNull();
  });

  it("finds the last statement when the cursor is at the very end of the string", () => {
    const s = statementAtCursor(sql, sql.length);
    expect(s?.sql).toBe("SELECT 3");
  });
});
