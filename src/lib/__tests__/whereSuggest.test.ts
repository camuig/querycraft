import { describe, expect, it } from "vitest";
import { applySuggestion, suggestWhere, wordAtCaret } from "../whereSuggest";

const columns = ["id", "account_id", "Amount", "created_at", "status"];

describe("wordAtCaret", () => {
  it("находит слово перед кареткой", () => {
    expect(wordAtCaret("acc", 3)).toEqual({ start: 0, end: 3, word: "acc" });
    expect(wordAtCaret("id > 1 and acc", 14)).toEqual({ start: 11, end: 14, word: "acc" });
  });

  it("учитывает хвост слова после каретки как часть заменяемого диапазона", () => {
    expect(wordAtCaret("account_id = 1", 3)).toEqual({ start: 0, end: 10, word: "acc" });
  });

  it("возвращает пустое слово после пробела или оператора", () => {
    expect(wordAtCaret("id = ", 5).word).toBe("");
    expect(wordAtCaret("id>", 3).word).toBe("");
  });
});

describe("suggestWhere", () => {
  it("предлагает колонки по префиксу без учёта регистра, колонки раньше ключевых слов", () => {
    const r = suggestWhere("a", 1, columns);
    expect(r.items.map((i) => i.text)).toEqual(["account_id", "Amount", "AND"]);
    expect(r.items[0].kind).toBe("column");
    expect(r.items[2].kind).toBe("keyword");
  });

  it("не предлагает уже полностью введённое слово", () => {
    const r = suggestWhere("account_id", 10, columns);
    expect(r.items).toEqual([]);
  });

  it("ничего не предлагает при пустом префиксе", () => {
    expect(suggestWhere("id = 1 ", 7, columns).items).toEqual([]);
    expect(suggestWhere("", 0, columns).items).toEqual([]);
  });

  it("подбирает слово в середине выражения и отдаёт его границы", () => {
    const r = suggestWhere("id > 10 AND st", 14, columns);
    expect(r.items.map((i) => i.text)).toEqual(["status"]);
    expect(r.wordStart).toBe(12);
    expect(r.wordEnd).toBe(14);
  });

  it("предлагает ключевые слова с пробелами (IS NULL)", () => {
    const r = suggestWhere("x is", 4, columns);
    expect(r.items.map((i) => i.text)).toEqual(["IS NULL", "IS NOT NULL"]);
  });

  it("ограничивает количество подсказок", () => {
    const many = Array.from({ length: 30 }, (_, i) => `col_${i}`);
    expect(suggestWhere("c", 1, many, 5).items).toHaveLength(5);
  });
});

describe("applySuggestion", () => {
  it("заменяет слово и ставит каретку в конец подстановки", () => {
    expect(applySuggestion("id > 10 AND st", 12, 14, "status")).toEqual({ text: "id > 10 AND status", caret: 18 });
  });

  it("заменяет слово целиком, включая хвост после каретки", () => {
    expect(applySuggestion("acc = 1", 0, 3, "account_id")).toEqual({ text: "account_id = 1", caret: 10 });
  });
});
