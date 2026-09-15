import { describe, expect, it } from "vitest";
import { applySuggestion, suggestWhere, wordAtCaret } from "../whereSuggest";

const columns = ["id", "account_id", "Amount", "created_at", "status"];

describe("wordAtCaret", () => {
  it("finds the word before the caret", () => {
    expect(wordAtCaret("acc", 3)).toEqual({ start: 0, end: 3, word: "acc" });
    expect(wordAtCaret("id > 1 and acc", 14)).toEqual({ start: 11, end: 14, word: "acc" });
  });

  it("includes the word's tail after the caret as part of the replaceable range", () => {
    expect(wordAtCaret("account_id = 1", 3)).toEqual({ start: 0, end: 10, word: "acc" });
  });

  it("returns an empty word after a space or an operator", () => {
    expect(wordAtCaret("id = ", 5).word).toBe("");
    expect(wordAtCaret("id>", 3).word).toBe("");
  });
});

describe("suggestWhere", () => {
  it("suggests columns by prefix case-insensitively, columns before keywords", () => {
    const r = suggestWhere("a", 1, columns);
    expect(r.items.map((i) => i.text)).toEqual(["account_id", "Amount", "AND"]);
    expect(r.items[0].kind).toBe("column");
    expect(r.items[2].kind).toBe("keyword");
  });

  it("does not suggest a word that is already fully typed", () => {
    const r = suggestWhere("account_id", 10, columns);
    expect(r.items).toEqual([]);
  });

  it("suggests nothing for an empty prefix", () => {
    expect(suggestWhere("id = 1 ", 7, columns).items).toEqual([]);
    expect(suggestWhere("", 0, columns).items).toEqual([]);
  });

  it("picks the word in the middle of an expression and returns its bounds", () => {
    const r = suggestWhere("id > 10 AND st", 14, columns);
    expect(r.items.map((i) => i.text)).toEqual(["status"]);
    expect(r.wordStart).toBe(12);
    expect(r.wordEnd).toBe(14);
  });

  it("suggests keywords containing spaces (IS NULL)", () => {
    const r = suggestWhere("x is", 4, columns);
    expect(r.items.map((i) => i.text)).toEqual(["IS NULL", "IS NOT NULL"]);
  });

  it("limits the number of suggestions", () => {
    const many = Array.from({ length: 30 }, (_, i) => `col_${i}`);
    expect(suggestWhere("c", 1, many, 5).items).toHaveLength(5);
  });
});

describe("applySuggestion", () => {
  it("replaces the word and places the caret at the end of the replacement", () => {
    expect(applySuggestion("id > 10 AND st", 12, 14, "status")).toEqual({ text: "id > 10 AND status", caret: 18 });
  });

  it("replaces the whole word, including the tail after the caret", () => {
    expect(applySuggestion("acc = 1", 0, 3, "account_id")).toEqual({ text: "account_id = 1", caret: 10 });
  });
});
