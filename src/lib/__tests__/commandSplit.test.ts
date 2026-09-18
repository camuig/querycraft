import { describe, expect, it } from "vitest";
import { commandAtCursor, splitCommands } from "../commandSplit";

describe("splitCommands", () => {
  it("splits one command per non-blank line", () => {
    const text = "GET foo\nSET bar 1\nHGETALL h";
    expect(splitCommands(text).map((s) => s.sql)).toEqual(["GET foo", "SET bar 1", "HGETALL h"]);
  });

  it("skips blank lines and `#` comments", () => {
    const text = "GET foo\n\n# a comment\n   \nSET bar 1\n  # indented comment\n";
    expect(splitCommands(text).map((s) => s.sql)).toEqual(["GET foo", "SET bar 1"]);
  });

  it("trims surrounding whitespace and reports correct offsets", () => {
    const text = "  GET foo  \nSET bar 1";
    const [first, second] = splitCommands(text);
    expect(first.sql).toBe("GET foo");
    expect(text.slice(first.from, first.to)).toBe("GET foo");
    expect(second.sql).toBe("SET bar 1");
    expect(text.slice(second.from, second.to)).toBe("SET bar 1");
  });

  it("returns an empty array for text with only blank lines and comments", () => {
    expect(splitCommands("\n# nothing here\n   \n")).toEqual([]);
  });
});

describe("commandAtCursor", () => {
  const text = "GET foo\n# a comment\nSET bar 1\n\nHGETALL h";

  it("returns the command on the cursor's line", () => {
    expect(commandAtCursor(text, 3)?.sql).toBe("GET foo");
    expect(commandAtCursor(text, text.indexOf("SET"))?.sql).toBe("SET bar 1");
    expect(commandAtCursor(text, text.length)?.sql).toBe("HGETALL h");
  });

  it("returns null on a comment line", () => {
    expect(commandAtCursor(text, text.indexOf("# a comment") + 2)).toBeNull();
  });

  it("returns null on a blank line", () => {
    const blankLinePos = text.indexOf("\n\nHGETALL") + 1;
    expect(commandAtCursor(text, blankLinePos)).toBeNull();
  });

  it("handles a cursor at the very start of the text", () => {
    expect(commandAtCursor(text, 0)?.sql).toBe("GET foo");
  });
});
