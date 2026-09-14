import { describe, expect, it } from "vitest";
import { detectDelimiter, expandToRange, parseClipboardTable, splitLine } from "../pasteParser";

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

describe("expandToRange", () => {
  it("одно значение заполняет весь диапазон", () => {
    expect(expandToRange([["x"]], 3, 2)).toEqual([
      ["x", "x"],
      ["x", "x"],
      ["x", "x"],
    ]);
  });

  it("одна строка повторяется по строкам диапазона", () => {
    expect(expandToRange([["a", "b"]], 2, 2)).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
  });

  it("одна колонка повторяется по колонкам", () => {
    expect(expandToRange([["a"], ["b"]], 2, 3)).toEqual([
      ["a", "a", "a"],
      ["b", "b", "b"],
    ]);
  });

  it("диапазон 1×1 — вставка как есть", () => {
    const v = [["a"], ["b"]];
    expect(expandToRange(v, 1, 1)).toBe(v);
  });

  it("матрица больше диапазона — как есть; некратный диапазон — по размеру матрицы", () => {
    const v = [["a"], ["b"]];
    expect(expandToRange(v, 1, 1)).toBe(v);
    expect(expandToRange(v, 3, 1)).toEqual([["a"], ["b"]]);
  });
});
