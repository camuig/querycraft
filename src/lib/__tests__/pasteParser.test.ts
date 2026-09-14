import { describe, expect, it } from "vitest";
import { detectDelimiter, parseClipboardTable, splitLine } from "../pasteParser";

describe("parseClipboardTable", () => {
  it("каждая строка без разделителя — одна колонка", () => {
    const text = "promokod_ekonom\nzapevrea\nochenkrasivye\n";
    expect(parseClipboardTable(text)).toEqual([["promokod_ekonom"], ["zapevrea"], ["ochenkrasivye"]]);
  });

  it("табуляция разбивает на колонки и имеет приоритет над запятой", () => {
    expect(parseClipboardTable("a,b\t1\nc\t2")).toEqual([
      ["a,b", "1"],
      ["c", "2"],
    ]);
  });

  it("запятая разбивает на соседние колонки", () => {
    expect(parseClipboardTable("alice,10\nbob,20")).toEqual([
      ["alice", "10"],
      ["bob", "20"],
    ]);
  });

  it("точка с запятой и вертикальная черта поддерживаются", () => {
    expect(parseClipboardTable("a;b")).toEqual([["a", "b"]]);
    expect(parseClipboardTable("a|b")).toEqual([["a", "b"]]);
  });

  it("CRLF и хвостовые пустые строки", () => {
    expect(parseClipboardTable("x\r\ny\r\n\r\n")).toEqual([["x"], ["y"]]);
  });

  it("пустые ячейки, NULL и <null> становятся null", () => {
    expect(parseClipboardTable("a,,NULL,<null>")).toEqual([["a", null, null, null]]);
  });

  it("пустой текст даёт пустую матрицу", () => {
    expect(parseClipboardTable("")).toEqual([]);
    expect(parseClipboardTable("\n\n")).toEqual([]);
  });

  it("кавычки CSV защищают разделитель и экранируют кавычку", () => {
    expect(splitLine('"a,b",c,"say ""hi"""', ",")).toEqual(["a,b", "c", 'say "hi"']);
  });

  it("detectDelimiter пропускает пустые строки в начале", () => {
    expect(detectDelimiter(["", "a\tb"])).toBe("\t");
    expect(detectDelimiter(["plain"])).toBeNull();
  });
});
