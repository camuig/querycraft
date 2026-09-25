// Pure helpers for the AI side chat (`src/store/aiChatStore.ts`, `src/components/ai/ChatPanel.tsx`):
// context keys, message construction ("Include current query", Explain/Optimize display labels) and
// the retry/regenerate history computation. No IPC or store access here — see aiChatStore.ts for the
// store-aware layer that calls into this module and into `prompts.ts`/`gather.ts`.

import type { AiMessage } from "../../api/types";
import { trimChatHistory } from "./prompts";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Exact text sent to (or received from) the model. */
  content: string;
  /**
   * Shown in the message bubble instead of `content`, rendered the same safe-Markdown way as an
   * assistant reply (so a fenced ```sql block in it renders as a code block). Used for messages whose
   * real `content` is a large generated prompt the user never typed (Explain/Optimize) or that embeds
   * a code block the user attached (the "Include current query" chip) — a plain, freely-typed message
   * has no `display` and renders as literal pre-wrap text instead, so it can never be reinterpreted as
   * Markdown by accident.
   */
  display?: string;
}

/** One conversation per connection + database — same rule the schema-context cache uses. */
export function contextKey(connectionId: string, database: string | null): string {
  return `${connectionId}/${database ?? ""}`;
}

function fencedBlock(lang: string, text: string): string {
  return [`\`\`\`${lang}`, text, "```"].join("\n");
}

/**
 * Builds the message content for the "Include current query" chip: the user's own text (if any)
 * followed by the attached statement as a fenced block. Also used as the message's `display` — unlike
 * Explain/Optimize there is no hidden instruction text to hide, so what is sent is what is shown.
 */
export function buildIncludeQueryMessage(text: string, sql: string, lang: "sql" | "redis" = "sql"): string {
  const trimmed = text.trim();
  const block = fencedBlock(lang, sql);
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/** Display text for the "Explain query" action — the real `content` sent to the model is `buildExplainMessage`. */
export function buildExplainDisplay(sql: string, lang: "sql" | "redis" = "sql"): string {
  return `Explain query\n${fencedBlock(lang, sql)}`;
}

/** Display text for the "Optimize query" action — the real `content` sent to the model is `buildOptimizeMessage`. */
export function buildOptimizeDisplay(sql: string, lang: "sql" | "redis" = "sql"): string {
  return `Optimize query\n${fencedBlock(lang, sql)}`;
}

/** Drops `display`: the exact role/content pairs a chat request sends to the model. */
export function toAiMessages(messages: ChatMessage[]): AiMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * The full, trimmed message list for a chat request: `history` (already-completed turns) plus a new
 * user turn with `userText`, capped by `trimChatHistory`'s message-count and character budget.
 */
export function buildRequestMessages(
  history: ChatMessage[],
  userText: string,
  opts?: { maxMessages?: number; maxChars?: number },
): AiMessage[] {
  const full: AiMessage[] = [...toAiMessages(history), { role: "user", content: userText }];
  return trimChatHistory(full, opts);
}

/**
 * What Retry needs to resend the last user turn: the history to resend against (everything before
 * that turn) and the exact `ChatMessage` to resend (preserving its `display`, so a retried
 * Explain/Optimize/"include query" message still shows its nice label instead of the raw prompt).
 * Returns null when there is nothing sensible to retry (empty history, or an assistant message with
 * no preceding user turn — defensive; should not happen with how the store builds `messages`).
 */
export function historyForRetry(messages: ChatMessage[]): { prior: ChatMessage[]; userMessage: ChatMessage } | null {
  if (messages.length === 0) return null;

  const last = messages[messages.length - 1];
  if (last.role === "user") {
    return { prior: messages.slice(0, -1), userMessage: last };
  }

  // last.role === "assistant": a partial/failed reply to the turn right before it.
  const withoutAssistant = messages.slice(0, -1);
  const user = withoutAssistant[withoutAssistant.length - 1];
  if (user?.role !== "user") return null;
  return { prior: withoutAssistant.slice(0, -1), userMessage: user };
}
