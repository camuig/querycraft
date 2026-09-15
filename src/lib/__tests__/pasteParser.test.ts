import { describe, expect, it } from "vitest";
import { detectDelimiter, expandToRange, parseClipboardTable, splitLine } from "../pasteParser";

describe("parseClipboardTable", () => {
  it("each line without a delimiter is a single column", () => {
    const text = "promokod_ekonom\nzapevrea\nochenkrasivye\n";
    expect(parseClipboardTable(text)).toEqual([["promokod_ekonom"], ["zapevrea"], ["ochenkrasivye"]]);
  });

  it("tab splits into columns and takes priority over comma", () => {
    expect(parseClipboardTable("a,b\t1\nc\t2")).toEqual([
      ["a,b", "1"],
      ["c", "2"],
    ]);
  });

  it("comma splits into adjacent columns", () => {
    expect(parseClipboardTable("alice,10\nbob,20")).toEqual([
      ["alice", "10"],
      ["bob", "20"],
    ]);
  });

  it("semicolon and pipe are supported", () => {
    expect(parseClipboardTable("a;b")).toEqual([["a", "b"]]);
    expect(parseClipboardTable("a|b")).toEqual([["a", "b"]]);
  });

  it("CRLF and trailing empty lines", () => {
    expect(parseClipboardTable("x\r\ny\r\n\r\n")).toEqual([["x"], ["y"]]);
  });

  it("empty cells, NULL and <null> become null", () => {
    expect(parseClipboardTable("a,,NULL,<null>")).toEqual([["a", null, null, null]]);
  });

  it("empty text yields an empty matrix", () => {
    expect(parseClipboardTable("")).toEqual([]);
    expect(parseClipboardTable("\n\n")).toEqual([]);
  });

  it("CSV quotes protect the delimiter and escape a quote", () => {
    expect(splitLine('"a,b",c,"say ""hi"""', ",")).toEqual(["a,b", "c", 'say "hi"']);
  });

  it("detectDelimiter skips leading empty lines", () => {
    expect(detectDelimiter(["", "a\tb"])).toBe("\t");
    expect(detectDelimiter(["plain"])).toBeNull();
  });
});

describe("expandToRange", () => {
  it("a single value fills the whole range", () => {
    expect(expandToRange([["x"]], 3, 2)).toEqual([
      ["x", "x"],
      ["x", "x"],
      ["x", "x"],
    ]);
  });

  it("a single row repeats down the range's rows", () => {
    expect(expandToRange([["a", "b"]], 2, 2)).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
  });

  it("a single column repeats across columns", () => {
    expect(expandToRange([["a"], ["b"]], 2, 3)).toEqual([
      ["a", "a", "a"],
      ["b", "b", "b"],
    ]);
  });

  it("a 1x1 range pastes as is", () => {
    const v = [["a"], ["b"]];
    expect(expandToRange(v, 1, 1)).toBe(v);
  });

  it("matrix larger than the range is left as is; non-multiple range keeps the matrix's size", () => {
    const v = [["a"], ["b"]];
    expect(expandToRange(v, 1, 1)).toBe(v);
    expect(expandToRange(v, 3, 1)).toEqual([["a"], ["b"]]);
  });
});
