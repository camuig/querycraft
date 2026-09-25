import { describe, expect, it } from "vitest";
import {
  buildExplainDisplay,
  buildIncludeQueryMessage,
  buildOptimizeDisplay,
  buildRequestMessages,
  type ChatMessage,
  contextKey,
  historyForRetry,
  toAiMessages,
} from "../chat";

describe("contextKey", () => {
  it("joins the connection and database", () => {
    expect(contextKey("conn-1", "shop")).toBe("conn-1/shop");
  });

  it("uses an empty database segment when there is none", () => {
    expect(contextKey("conn-1", null)).toBe("conn-1/");
  });
});

describe("buildIncludeQueryMessage", () => {
  it("attaches the statement as a fenced block when there is no typed text", () => {
    expect(buildIncludeQueryMessage("", "SELECT 1")).toBe("```sql\nSELECT 1\n```");
  });

  it("keeps the typed text above the block", () => {
    expect(buildIncludeQueryMessage("Why is this slow?", "SELECT 1")).toBe(
      "Why is this slow?\n\n```sql\nSELECT 1\n```",
    );
  });

  it("trims the typed text", () => {
    expect(buildIncludeQueryMessage("  hello  ", "SELECT 1")).toBe("hello\n\n```sql\nSELECT 1\n```");
  });

  it("fences with the given language", () => {
    expect(buildIncludeQueryMessage("", "GET user:1", "redis")).toBe("```redis\nGET user:1\n```");
  });
});

describe("buildExplainDisplay / buildOptimizeDisplay", () => {
  it("labels the statement without the full instruction text", () => {
    expect(buildExplainDisplay("SELECT 1")).toBe("Explain query\n```sql\nSELECT 1\n```");
    expect(buildOptimizeDisplay("SELECT 1")).toBe("Optimize query\n```sql\nSELECT 1\n```");
  });
});

describe("toAiMessages", () => {
  it("drops the id and display, keeping only role and content", () => {
    const messages: ChatMessage[] = [
      { id: "1", role: "user", content: "hi", display: "shown differently" },
      { id: "2", role: "assistant", content: "hello" },
    ];
    expect(toAiMessages(messages)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });
});

describe("buildRequestMessages", () => {
  it("appends the new user turn to the history", () => {
    const history: ChatMessage[] = [
      { id: "1", role: "user", content: "first" },
      { id: "2", role: "assistant", content: "reply" },
    ];
    expect(buildRequestMessages(history, "second")).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]);
  });

  it("trims down to the character budget while always keeping the latest message", () => {
    const history: ChatMessage[] = [{ id: "1", role: "user", content: "a".repeat(100) }];
    const result = buildRequestMessages(history, "b".repeat(50), { maxChars: 60 });
    expect(result).toEqual([{ role: "user", content: "b".repeat(50) }]);
  });
});

describe("historyForRetry", () => {
  it("returns null for an empty history", () => {
    expect(historyForRetry([])).toBeNull();
  });

  it("resends a lone user turn (a config error that never produced a reply)", () => {
    const user: ChatMessage = { id: "1", role: "user", content: "hi" };
    expect(historyForRetry([user])).toEqual({ prior: [], userMessage: user });
  });

  it("drops a trailing partial/failed assistant reply and resends its user turn", () => {
    const user: ChatMessage = { id: "1", role: "user", content: "hi", display: "Explain query\n```sql\nx\n```" };
    const assistant: ChatMessage = { id: "2", role: "assistant", content: "partial…" };
    const before: ChatMessage = { id: "0", role: "user", content: "earlier" };
    const beforeReply: ChatMessage = { id: "0b", role: "assistant", content: "earlier reply" };
    expect(historyForRetry([before, beforeReply, user, assistant])).toEqual({
      prior: [before, beforeReply],
      userMessage: user,
    });
  });

  it("returns null when an assistant message has no preceding user turn", () => {
    const assistant: ChatMessage = { id: "1", role: "assistant", content: "stray" };
    expect(historyForRetry([assistant])).toBeNull();
  });
});
