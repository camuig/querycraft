import { describe, expect, it } from "vitest";
import { keyPreviewCommand, quoteRedisKey } from "../redisCommands";

describe("quoteRedisKey", () => {
  it("wraps a plain key in double quotes", () => {
    expect(quoteRedisKey("user:1")).toBe('"user:1"');
  });

  it("escapes backslashes and double quotes", () => {
    expect(quoteRedisKey('weird"key\\name')).toBe('"weird\\"key\\\\name"');
  });
});

describe("keyPreviewCommand", () => {
  it("maps every known key type to its preview command", () => {
    expect(keyPreviewCommand("k", "string")).toBe('GET "k"');
    expect(keyPreviewCommand("k", "hash")).toBe('HGETALL "k"');
    expect(keyPreviewCommand("k", "list")).toBe('LRANGE "k" 0 -1');
    expect(keyPreviewCommand("k", "set")).toBe('SMEMBERS "k"');
    expect(keyPreviewCommand("k", "zset")).toBe('ZRANGE "k" 0 -1 WITHSCORES');
    expect(keyPreviewCommand("k", "stream")).toBe('XRANGE "k" - + COUNT 100');
  });

  it("falls back to TYPE for unknown key types", () => {
    expect(keyPreviewCommand("k", "unknown")).toBe('TYPE "k"');
  });

  it("quotes the key name inside the command", () => {
    expect(keyPreviewCommand('a"b', "string")).toBe('GET "a\\"b"');
  });
});
