import { CompletionContext } from "@codemirror/autocomplete";
import { StringStream } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { redisCompletionSource, redisParser } from "../redisLanguage";

/**
 * Runs the stream parser over one line, returning the token style for each non-whitespace
 * token it reads (whitespace between tokens is its own null-style token from `eatSpace`, of no
 * interest here).
 */
function tokenizeLine(line: string): { text: string; style: string | null }[] {
  const state = redisParser.startState?.(2) ?? { wordIndex: 0 };
  const stream = new StringStream(line, 2, 2);
  const out: { text: string; style: string | null }[] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = redisParser.token(stream, state);
    if (stream.pos === stream.start) break;
    const text = stream.current();
    if (text.trim() === "") continue;
    out.push({ text, style });
  }
  return out;
}

describe("redisParser tokenizer", () => {
  it("highlights a known command as a keyword and leaves the key plain", () => {
    const tokens = tokenizeLine('SET "my key" 42');
    expect(tokens[0]).toEqual({ text: "SET", style: "keyword" });
    expect(tokens[1]).toEqual({ text: '"my key"', style: "string" });
    expect(tokens[2]).toEqual({ text: "42", style: "number" });
  });

  it("recognizes single-quoted strings", () => {
    const tokens = tokenizeLine("GET 'foo bar'");
    expect(tokens[0].style).toBe("keyword");
    expect(tokens[1]).toEqual({ text: "'foo bar'", style: "string" });
  });

  it("handles backslash escapes inside double-quoted strings", () => {
    const tokens = tokenizeLine('SET "a\\"b"');
    expect(tokens[1].text).toBe('"a\\"b"');
    expect(tokens[1].style).toBe("string");
  });

  it("treats an unknown first word as plain text", () => {
    const tokens = tokenizeLine("NOTACOMMAND foo");
    expect(tokens[0]).toEqual({ text: "NOTACOMMAND", style: null });
  });

  it("only highlights the first word as a command, case-insensitively", () => {
    const tokens = tokenizeLine("get somekey");
    expect(tokens[0]).toEqual({ text: "get", style: "keyword" });
    expect(tokens[1]).toEqual({ text: "somekey", style: null });
  });

  it("highlights a `#` comment only at the start of the line", () => {
    const tokens = tokenizeLine("# this is a comment");
    expect(tokens).toEqual([{ text: "# this is a comment", style: "comment" }]);
  });

  it("highlights the sub-command of a two-word command", () => {
    const tokens = tokenizeLine("CONFIG GET maxmemory");
    expect(tokens[0]).toEqual({ text: "CONFIG", style: "keyword" });
    expect(tokens[1]).toEqual({ text: "GET", style: "keyword" });
    expect(tokens[2]).toEqual({ text: "maxmemory", style: null });
  });
});

describe("redisCompletionSource", () => {
  function ctx(doc: string, pos: number) {
    const state = EditorState.create({ doc });
    return new CompletionContext(state, pos, true);
  }

  it("offers commands at the start of a line", () => {
    const source = redisCompletionSource(["mykey"]);
    const result = source(ctx("GE", 2));
    expect(result).not.toBeNull();
    const labels = result?.options.map((o) => o.label) ?? [];
    expect(labels).toContain("GET");
    expect(labels).toContain("GETRANGE");
  });

  it("offers key names in the middle of a line", () => {
    const source = redisCompletionSource(["user:1", "user:2"]);
    const result = source(ctx("GET user", 8));
    expect(result).not.toBeNull();
    const labels = result?.options.map((o) => o.label) ?? [];
    expect(labels).toEqual(["user:1", "user:2"]);
  });

  it("returns no key completion when no keys are known", () => {
    const source = redisCompletionSource(undefined);
    const result = source(ctx("GET user", 8));
    expect(result).toBeNull();
  });

  it("offers CONFIG sub-commands, not top-level commands, as the second word", () => {
    const source = redisCompletionSource();
    const result = source(ctx("CONFIG GE", 9));
    expect(result).not.toBeNull();
    const labels = result?.options.map((o) => o.label) ?? [];
    expect(labels).toEqual(["GET", "SET", "REWRITE", "RESETSTAT"]);
    expect(labels).not.toContain("HSET");
  });
});
