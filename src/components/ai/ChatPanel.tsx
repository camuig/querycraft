import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { insertAtCursor } from "../../lib/ai/accept";
import { buildIncludeQueryMessage, type ChatMessage, contextKey } from "../../lib/ai/chat";
import { commandAtCursor } from "../../lib/commandSplit";
import { getConsoleEditor } from "../../lib/editorRegistry";
import { statementAtCursor } from "../../lib/sqlSplit";
import { type AiChatContext, EMPTY_CONVERSATION, useAiChatStore } from "../../store/aiChatStore";
import { getActiveAiConfig, useAiStore } from "../../store/aiStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useTabsStore } from "../../store/tabsStore";
import { toast } from "../../store/toastStore";
import { MarkdownView } from "./MarkdownView";
import { type ChatContextInfo, useChatContext } from "./useChatContext";
import "../../styles/ai-chat.css";

const EXAMPLE_PROMPTS = [
  "Which tables reference customers?",
  "Write a query for monthly revenue",
  "Explain the current query",
];

/** Textarea grows with its content up to roughly 8 lines, then scrolls. */
const MAX_TEXTAREA_HEIGHT = 160;

function accessLabel(access: ChatContextInfo["aiAccess"]): string {
  if (access === "schema") return "Query and schema";
  if (access === "query") return "Query only";
  return "AI disabled";
}

function isConfigError(error: string | null): boolean {
  return (
    error === "Choose an AI provider in Settings" ||
    !!error?.startsWith("Add an API key") ||
    error === "Choose a model in Settings"
  );
}

/** The active console's statement at the cursor/selection — same rule Run and Explain/Optimize use. */
function currentConsoleStatement(ctx: ChatContextInfo): string | null {
  const consoleTab = ctx.activeConsole;
  if (!consoleTab) return null;
  const view = getConsoleEditor(consoleTab.id);
  const text = view ? view.state.doc.toString() : consoleTab.sql;
  const sel = view?.state.selection.main;
  if (sel && !sel.empty) return text.slice(sel.from, sel.to);
  const pos = sel ? sel.head : text.length;
  if (ctx.queryLanguage === "redis") {
    const cmd = commandAtCursor(text, pos);
    return cmd ? cmd.sql : null;
  }
  const stmt = statementAtCursor(text, pos, { dollarQuoting: ctx.kind === "postgres" });
  return stmt ? stmt.sql : null;
}

/** Inserts `code` into the active console of `connectionId`, or opens a new one when there isn't one. */
function insertIntoConsole(ctx: ChatContextInfo, code: string) {
  if (!ctx.connectionId) return;
  const consoleTab = ctx.activeConsole;
  const view = consoleTab ? getConsoleEditor(consoleTab.id) : undefined;
  if (view) {
    const doc = view.state.doc.toString();
    const pos = view.state.selection.main.head;
    const edit = insertAtCursor(doc, pos, code);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: edit.selectionFrom, head: edit.selectionTo },
      scrollIntoView: true,
      userEvent: "input",
    });
    view.focus();
    return;
  }
  useTabsStore.getState().openConsole(ctx.connectionId, ctx.database, code);
}

interface ChatBubbleProps {
  message: ChatMessage;
  /** True while this message is the assistant reply currently streaming in. */
  streaming: boolean;
  onInsertCode: (code: string, lang: string) => void;
}

function ChatBubble({ message, streaming, onInsertCode }: ChatBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="chat-message chat-message-user">
        {message.display !== undefined ? (
          <MarkdownView text={message.display} onInsertCode={onInsertCode} />
        ) : (
          <div className="chat-user-text">{message.content}</div>
        )}
      </div>
    );
  }
  return (
    <div className="chat-message chat-message-assistant">
      {message.content ? (
        <>
          <MarkdownView text={message.content} onInsertCode={onInsertCode} />
          {streaming && <span className="chat-cursor" aria-hidden="true" />}
        </>
      ) : streaming ? (
        <span className="chat-thinking" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : null}
    </div>
  );
}

/** Right-side AI chat panel: one conversation per connection + database (see `aiChatStore`). */
export function ChatPanel() {
  const ctx = useChatContext();
  const [input, setInput] = useState("");
  const [includeQuery, setIncludeQuery] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const openSettings = useSettingsStore((s) => s.openDialog);

  const aiProviderId = useSettingsStore((s) => s.aiProviderId);
  const aiModels = useSettingsStore((s) => s.aiModels);
  const aiKeyStatus = useAiStore((s) => s.keyStatus);
  // Reactive mirror of getActiveAiConfig()'s "is anything usable configured" check (same pattern as
  // ConsoleTab's inline completion source), keyed on the settings/key-status slices it reads via getState().
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on those slices, not referenced directly
  const aiConfigured = useMemo(() => !("error" in getActiveAiConfig()), [aiProviderId, aiModels, aiKeyStatus]);

  const key = ctx.connectionId ? contextKey(ctx.connectionId, ctx.database) : null;
  const conversation = useAiChatStore((s) => (key ? (s.conversations[key] ?? EMPTY_CONVERSATION) : EMPTY_CONVERSATION));
  const streaming = conversation.status === "streaming";

  const chatContext: AiChatContext | null = ctx.connectionId
    ? {
        connectionId: ctx.connectionId,
        database: ctx.database,
        kind: ctx.kind,
        aiAccess: ctx.aiAccess,
        serverVersion: ctx.serverVersion,
      }
    : null;

  // Opening the chat focuses the input (the panel mounts only while open — see AppShell).
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Re-runs on every streaming delta (a new `messages` array) to keep the view pinned to the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation.messages is a deliberate re-run trigger, not read in the body
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [conversation.messages]);

  useEffect(() => {
    if (input === "" && textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, []);

  const handleSend = useCallback(() => {
    if (!chatContext) return;
    const text = input.trim();
    if (!text) return;
    let content = text;
    let display: string | undefined;
    if (includeQuery) {
      const sql = currentConsoleStatement(ctx)?.trim();
      if (sql) {
        content = buildIncludeQueryMessage(text, sql, ctx.queryLanguage);
        display = content;
      } else {
        toast.error("No statement to include");
      }
    }
    useAiChatStore.getState().send(chatContext, content, display);
    setInput("");
    setIncludeQuery(false);
    stickToBottomRef.current = true;
  }, [chatContext, input, includeQuery, ctx]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleExample = useCallback(
    (text: string) => {
      if (!chatContext) return;
      stickToBottomRef.current = true;
      useAiChatStore.getState().send(chatContext, text);
    },
    [chatContext],
  );

  const handleInsertCode = useCallback((code: string) => insertIntoConsole(ctx, code), [ctx]);
  const handleStop = useCallback(() => {
    if (key) useAiChatStore.getState().stop(key);
  }, [key]);
  const handleRetry = useCallback(() => {
    if (chatContext) useAiChatStore.getState().retry(chatContext);
  }, [chatContext]);
  const handleNewChat = useCallback(() => {
    if (key) useAiChatStore.getState().clear(key);
  }, [key]);

  const contextLabel = ctx.connectionName
    ? ctx.database
      ? `${ctx.connectionName} / ${ctx.database}`
      : ctx.connectionName
    : null;

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">AI Chat</span>
        {contextLabel && (
          <span className="chat-context-label" title={contextLabel}>
            {contextLabel}
            {ctx.aiAccess !== "off" && <span className="muted"> · {accessLabel(ctx.aiAccess)}</span>}
          </span>
        )}
        <div className="spacer" />
        <button
          type="button"
          className="outline"
          onClick={handleNewChat}
          disabled={!key || conversation.messages.length === 0}
        >
          New chat
        </button>
        <button
          type="button"
          className="icon"
          title="Close"
          onClick={() => useSettingsStore.getState().setAiChatOpen(false)}
        >
          ✕
        </button>
      </div>

      <div className="chat-body">
        {!ctx.connectionId ? (
          <div className="chat-empty-state">
            <p>Select a connection or open a console.</p>
          </div>
        ) : ctx.aiAccess === "off" ? (
          <div className="chat-empty-state">
            <p>AI is disabled for this connection.</p>
          </div>
        ) : !aiConfigured ? (
          <div className="chat-empty-state">
            <p>Configure an AI provider to use the chat.</p>
            <button type="button" onClick={() => openSettings("ai")}>
              Open settings
            </button>
          </div>
        ) : (
          <>
            <div className="chat-messages" ref={listRef} onScroll={handleScroll}>
              {conversation.messages.length === 0 ? (
                <div className="chat-intro">
                  <p>Ask about {ctx.connectionName ?? "this connection"}, get help writing SQL, or explain a query.</p>
                  <div className="chat-examples">
                    {EXAMPLE_PROMPTS.map((prompt) => (
                      <button
                        type="button"
                        key={prompt}
                        className="outline chat-example"
                        onClick={() => handleExample(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                conversation.messages.map((message, i) => (
                  <ChatBubble
                    key={message.id}
                    message={message}
                    streaming={streaming && i === conversation.messages.length - 1 && message.role === "assistant"}
                    onInsertCode={handleInsertCode}
                  />
                ))
              )}
              {conversation.status === "error" && (
                <div className="chat-error-bar">
                  <span className="danger chat-error-text">
                    {isConfigError(conversation.error) ? (
                      <>
                        {conversation.error}.{" "}
                        <button type="button" className="link" onClick={() => openSettings("ai")}>
                          Open settings
                        </button>
                      </>
                    ) : (
                      conversation.error
                    )}
                  </span>
                  <div className="spacer" />
                  <button type="button" onClick={handleRetry}>
                    Retry
                  </button>
                </div>
              )}
            </div>

            <div className="chat-composer">
              {ctx.activeConsole && (
                <button
                  type="button"
                  className={`chat-chip${includeQuery ? " active" : ""}`}
                  onClick={() => setIncludeQuery((v) => !v)}
                >
                  {includeQuery ? "✓" : "+"} Include current query
                </button>
              )}
              <div className="chat-input-row">
                <textarea
                  ref={textareaRef}
                  className="chat-input"
                  placeholder="Ask about this database…"
                  value={input}
                  onChange={handleInput}
                  onKeyDown={handleKeyDown}
                  disabled={streaming}
                  rows={1}
                />
                {streaming ? (
                  <button type="button" className="primary" onClick={handleStop}>
                    ■ Stop
                  </button>
                ) : (
                  <button type="button" className="primary" onClick={handleSend} disabled={!input.trim()}>
                    Send
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
