// Side chat conversations: one per `contextKey(connectionId, database)`. Deliberately NOT persisted
// (`create` with no `persist` middleware) — conversations may include schema and query text, and are
// only ever meant to live for the current session, in memory, like the console AI assist bar.

import { create } from "zustand";
import { aiCancel, aiChat } from "../api/commands";
import type { AiAccess, DbKind } from "../api/types";
import { buildRequestMessages, type ChatMessage, contextKey, historyForRetry } from "../lib/ai/chat";
import { gatherSchemaContext } from "../lib/ai/gather";
import { buildChatSystemPrompt } from "../lib/ai/prompts";
import { dialectFor } from "../lib/dialect";
import { newId } from "../lib/ids";
import { getActiveAiConfig } from "./aiStore";

export type ChatStatus = "idle" | "streaming" | "error";

export interface ChatConversation {
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
  /** In-flight request id (for `stop`/staleness checks); null when nothing is streaming. */
  requestId: string | null;
}

/** Everything `send`/`retry` need beyond the message text: the active connection/database and how
 * much of the schema they may see. Mirrors `PromptContext` plus the store-only `includeIndexes`
 * flag ("Optimize query" wants index definitions alongside the execution plan). */
export interface AiChatContext {
  connectionId: string;
  database: string | null;
  kind: DbKind;
  aiAccess: AiAccess;
  serverVersion?: string | null;
  includeIndexes?: boolean;
}

interface AiChatState {
  conversations: Record<string, ChatConversation>;
  /** Sends `content` as a new user turn (optionally shown as `display` instead — see `ChatMessage`). */
  send: (ctx: AiChatContext, content: string, display?: string) => void;
  /** Cancels the conversation's in-flight request, if any; a no-op otherwise. */
  stop: (key: string) => void;
  /** Resends the last user turn (dropping a trailing partial/failed reply, if there is one). */
  retry: (ctx: AiChatContext) => void;
  /** Cancels any in-flight request and resets the conversation to empty ("New chat"). */
  clear: (key: string) => void;
}

export const EMPTY_CONVERSATION: ChatConversation = { messages: [], status: "idle", error: null, requestId: null };

function isCancelled(e: unknown): boolean {
  return e instanceof Error ? e.message === "Cancelled" : String(e) === "Cancelled";
}

export const useAiChatStore = create<AiChatState>()((set, get) => {
  function conversationOf(key: string): ChatConversation {
    return get().conversations[key] ?? EMPTY_CONVERSATION;
  }

  function patch(key: string, next: Partial<ChatConversation>) {
    set((s) => ({ conversations: { ...s.conversations, [key]: { ...conversationOf(key), ...next } } }));
  }

  /** Runs one request/response turn: `prior` is the already-completed history, `userMessage` the new
   * turn to send (built fresh by `send`, or reused as-is by `retry` so its `display` survives). */
  async function run(key: string, ctx: AiChatContext, prior: ChatMessage[], userMessage: ChatMessage) {
    const config = getActiveAiConfig();
    if ("error" in config) {
      patch(key, { messages: [...prior, userMessage], status: "error", error: config.error, requestId: null });
      return;
    }

    const requestId = newId();
    const assistantId = newId();
    patch(key, {
      messages: [...prior, userMessage, { id: assistantId, role: "assistant", content: "" }],
      status: "streaming",
      error: null,
      requestId,
    });

    let schema = "";
    if (ctx.aiAccess === "schema" && ctx.database) {
      try {
        schema = await gatherSchemaContext(ctx.connectionId, ctx.database, userMessage.content, {
          includeIndexes: ctx.includeIndexes,
        });
      } catch {
        schema = "";
      }
    }

    const dialect = dialectFor(ctx.kind);
    const system = buildChatSystemPrompt({
      dialectLabel: dialect.label,
      queryLanguage: dialect.queryLanguage,
      serverVersion: ctx.serverVersion,
      database: ctx.database,
      schema,
    });
    const messages = buildRequestMessages(prior, userMessage.content);

    const setAssistantText = (content: string) => {
      set((s) => {
        const conv = s.conversations[key];
        if (!conv || conv.requestId !== requestId) return s;
        return {
          conversations: {
            ...s.conversations,
            [key]: { ...conv, messages: conv.messages.map((m) => (m.id === assistantId ? { ...m, content } : m)) },
          },
        };
      });
    };

    let accumulated = "";
    try {
      const full = await aiChat(
        { requestId, endpoint: config.endpoint, model: config.model, system, messages, maxTokens: 16000 },
        (event) => {
          if (event.kind !== "delta" || conversationOf(key).requestId !== requestId) return;
          accumulated += event.text;
          setAssistantText(accumulated);
        },
      );
      if (conversationOf(key).requestId !== requestId) return; // superseded (stopped/cleared) meanwhile
      setAssistantText(full);
      patch(key, { status: "idle", error: null, requestId: null });
    } catch (e) {
      if (conversationOf(key).requestId !== requestId) return;
      if (isCancelled(e)) {
        // A user Stop: keep whatever streamed in so far as the final answer, no error shown.
        patch(key, { status: "idle", error: null, requestId: null });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      patch(key, { status: "error", error: message, requestId: null });
    }
  }

  return {
    conversations: {},

    send: (ctx, content, display) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const key = contextKey(ctx.connectionId, ctx.database);
      const conv = conversationOf(key);
      const userMessage: ChatMessage = { id: newId(), role: "user", content: trimmed, display };
      void run(key, ctx, conv.messages, userMessage);
    },

    stop: (key) => {
      const requestId = conversationOf(key).requestId;
      if (requestId) aiCancel(requestId).catch(() => undefined);
    },

    retry: (ctx) => {
      const key = contextKey(ctx.connectionId, ctx.database);
      const info = historyForRetry(conversationOf(key).messages);
      if (!info) return;
      void run(key, ctx, info.prior, info.userMessage);
    },

    clear: (key) => {
      const requestId = conversationOf(key).requestId;
      if (requestId) aiCancel(requestId).catch(() => undefined);
      set((s) => ({ conversations: { ...s.conversations, [key]: { ...EMPTY_CONVERSATION } } }));
    },
  };
});
