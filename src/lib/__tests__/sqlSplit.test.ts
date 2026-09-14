import { describe, expect, it } from "vitest";
import { splitStatements, statementAtCursor } from "../sqlSplit";

describe("splitStatements", () => {
  it("разбивает простую строку по ;", () => {
    const stmts = splitStatements("SELECT 1; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("пропускает пустые выражения между ;;", () => {
    const stmts = splitStatements("SELECT 1;;SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("не разбивает по ; внутри одинарных кавычек", () => {
    const stmts = splitStatements("SELECT 'a;b'; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 'a;b'", "SELECT 2"]);
  });

  it("не разбивает по ; внутри двойных кавычек", () => {
    const stmts = splitStatements('SELECT "a;b"; SELECT 2;');
    expect(stmts.map((s) => s.sql)).toEqual(['SELECT "a;b"', "SELECT 2"]);
  });

  it("не разбивает по ; внутри backtick-идентификаторов", () => {
    const stmts = splitStatements("SELECT `a;b` FROM t; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT `a;b` FROM t", "SELECT 2"]);
  });

  it("поддерживает экранирование бэкслешем внутри строки", () => {
    const stmts = splitStatements("SELECT 'a\\'b;c'; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 'a\\'b;c'", "SELECT 2"]);
  });

  it("поддерживает экранирование удвоением кавычки", () => {
    const stmts = splitStatements("SELECT 'a''b;c'; SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 'a''b;c'", "SELECT 2"]);
  });

  it("-- комментарий (с пробелом после) не разбивает по ; внутри себя", () => {
    const stmts = splitStatements("SELECT 1; -- comment; still comment\nSELECT 2;");
    // ';' внутри комментария игнорируется, поэтому комментарий остаётся
    // частью того же выражения, что и следующий за ним SELECT 2.
    expect(stmts.map((s) => s.sql)).toEqual([
      "SELECT 1",
      "-- comment; still comment\nSELECT 2",
    ]);
  });

  it("не считает --комментарий (без пробела) комментарием, ; после него значим", () => {
    const stmts = splitStatements("SELECT 1--x\n;SELECT 2;");
    // "--x" без пробела после -- не комментарий по правилам MySQL,
    // значит это часть выражения до следующего ;
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1--x", "SELECT 2"]);
  });

  it("# комментарий не разбивает по ; внутри себя", () => {
    const stmts = splitStatements("SELECT 1; # comment ; still\nSELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1", "# comment ; still\nSELECT 2"]);
  });

  it("блочный комментарий /* ... */ не разбивает по ; внутри себя", () => {
    const stmts = splitStatements("SELECT 1; /* comment ; with semi */ SELECT 2;");
    expect(stmts.map((s) => s.sql)).toEqual([
      "SELECT 1",
      "/* comment ; with semi */ SELECT 2",
    ]);
  });

  it("поддерживает DELIMITER // для хранимой процедуры", () => {
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

  it("не включает строку DELIMITER в результат ни как отдельное выражение", () => {
    const stmts = splitStatements("DELIMITER $$\nSELECT 1$$\nDELIMITER ;\n");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1"]);
  });

  it("from/to указывают на offset в исходной (не обрезанной) строке", () => {
    const sql = "  SELECT 1  ;  SELECT 2;";
    const stmts = splitStatements(sql);
    expect(stmts[0].sql).toBe("SELECT 1");
    expect(sql.slice(stmts[0].from, stmts[0].to)).toBe("SELECT 1");
    expect(stmts[1].sql).toBe("SELECT 2");
    expect(sql.slice(stmts[1].from, stmts[1].to)).toBe("SELECT 2");
  });

  it("пустая строка даёт пустой результат", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   \n\n  ")).toEqual([]);
  });

  it("выражение из одних комментариев пропускается", () => {
    const stmts = splitStatements("-- just a comment\n;\nSELECT 1;");
    expect(stmts.map((s) => s.sql)).toEqual(["SELECT 1"]);
  });
});

describe("statementAtCursor", () => {
  const sql = "SELECT 1; SELECT 2; SELECT 3;";
  // индексы: "SELECT 1" [0,8) ";"=8 " "=9 "SELECT 2" [10,18) ";"=18 " "=19 "SELECT 3" [20,28) ";"=28

  it("находит выражение, когда курсор в его середине", () => {
    const s = statementAtCursor(sql, 3);
    expect(s?.sql).toBe("SELECT 1");
  });

  it("находит выражение, когда курсор на его границе (from)", () => {
    const s = statementAtCursor(sql, 0);
    expect(s?.sql).toBe("SELECT 1");
  });

  it("считает курсор сразу после ; всё ещё внутри предыдущего выражения", () => {
    const s = statementAtCursor(sql, 9); // сразу после первого ";"
    expect(s?.sql).toBe("SELECT 1");
  });

  it("считает курсор в пробелах между выражениями внутри предыдущего", () => {
    const s = statementAtCursor(sql, 19); // пробел между вторым ";" и третьим SELECT
    expect(s?.sql).toBe("SELECT 2");
  });

  it("возвращает null для пустой строки", () => {
    expect(statementAtCursor("", 0)).toBeNull();
  });

  it("возвращает null, если курсор до начала первого выражения (нет предыдущего)", () => {
    const s = statementAtCursor("   SELECT 1;", 1);
    expect(s).toBeNull();
  });

  it("находит последнее выражение, когда курсор в самом конце строки", () => {
    const s = statementAtCursor(sql, sql.length);
    expect(s?.sql).toBe("SELECT 3");
  });
});
