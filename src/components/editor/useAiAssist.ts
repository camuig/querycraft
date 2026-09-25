import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import { aiCancel, aiChat } from "../../api/commands";
import type { AiAccess, AiMessage, DbKind } from "../../api/types";
import { acceptEditSelection, acceptFix, insertAtCursor } from "../../lib/ai/accept";
import { gatherSchemaContext } from "../../lib/ai/gather";
import { buildFixMessage, buildGenerateMessage, buildSystemPrompt, extractSql } from "../../lib/ai/prompts";
import { dialectFor } from "../../lib/dialect";
import { newId } from "../../lib/ids";
import { getActiveAiConfig } from "../../store/aiStore";

/** What was remembered when the bar was opened, and how Accept should apply the answer. */
export type AiAssistMode =
  | { kind: "selection"; from: number; to: number; text: string }
  | { kind: "insert"; pos: number }
  | { kind: "fix"; anchorPos: number; sql: string; error: string };

export type AiAssistStatus = "closed" | "prompting" | "streaming" | "result" | "error";

export interface AiAssistState {
  status: AiAssistStatus;
  mode: AiAssistMode | null;
  /** Text currently in the bar's input: the instruction being composed, or a follow-up refine. */
  draft: string;
  /** Conversation completed so far — excludes the in-flight/last user turn. */
  messages: AiMessage[];
  /** Exact content of the last (or in-flight) user turn, for Regenerate/Retry. */
  lastUserText: string;
  /** Accumulated answer text (may include the fence and comments; render through `extractSql`). */
  text: string;
  error: string | null;
}

const CLOSED_STATE: AiAssistState = {
  status: "closed",
  mode: null,
  draft: "",
  messages: [],
  lastUserText: "",
  text: "",
  error: null,
};

export interface UseAiAssistOptions {
  connectionId: string;
  database: string | null;
  kind: DbKind;
  aiAccess: AiAccess;
  serverVersion?: string | null;
  editorRef: React.MutableRefObject<EditorView | null>;
}

export interface AiAssistApi {
  state: AiAssistState;
  openGenerate: () => void;
  openFix: (input: { sql: string; error: string }) => void;
  close: () => void;
  setDraft: (text: string) => void;
  /** Sends the draft: the initial instruction from "prompting", or a follow-up from "result". */
  submit: () => void;
  /** Cancels the in-flight request; the bar stays open and returns to an editable draft. */
  stop: () => void;
  /** Re-runs the last request from scratch (drops the previous answer). */
  regenerate: () => void;
  /** Re-runs the request that just failed. */
  retry: () => void;
  accept: () => void;
  discard: () => void;
}

function isCancelled(e: unknown): boolean {
  return e instanceof Error ? e.message === "Cancelled" : String(e) === "Cancelled";
}

/**
 * State machine behind `AiAssistBar`: closed -> prompting -> streaming -> result (or error), with a
 * follow-up looping back from result to streaming. Network/IPC calls and prompt building live here;
 * `AiAssistBar` only renders `state` and calls these actions. The document edit computation itself is
 * pure (`src/lib/ai/accept.ts`), so `accept()` just applies it to the `EditorView`.
 */
export function useAiAssist(opts: UseAiAssistOptions): AiAssistApi {
  const { connectionId, database, kind, aiAccess, serverVersion, editorRef } = opts;
  const [state, setState] = useState<AiAssistState>(CLOSED_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestIdRef = useRef<string | null>(null);

  const cancelRunning = useCallback(() => {
    const id = requestIdRef.current;
    if (id) aiCancel(id).catch(() => undefined);
  }, []);

  // A running request must not survive the console tab going away.
  useEffect(() => () => cancelRunning(), [cancelRunning]);

  const runRequest = useCallback(
    async (mode: AiAssistMode, priorMessages: AiMessage[], userText: string) => {
      const config = getActiveAiConfig();
      if ("error" in config) {
        setState({
          status: "error",
          mode,
          draft: "",
          messages: priorMessages,
          lastUserText: userText,
          text: "",
          error: config.error,
        });
        return;
      }

      const requestId = newId();
      requestIdRef.current = requestId;
      setState({
        status: "streaming",
        mode,
        draft: "",
        messages: priorMessages,
        lastUserText: userText,
        text: "",
        error: null,
      });

      let schema = "";
      if (aiAccess === "schema" && database) {
        try {
          schema = await gatherSchemaContext(connectionId, database, userText);
        } catch {
          schema = "";
        }
      }

      const dialect = dialectFor(kind);
      const system = buildSystemPrompt({
        dialectLabel: dialect.label,
        queryLanguage: dialect.queryLanguage,
        serverVersion,
        database,
        schema,
      });
      const messages: AiMessage[] = [...priorMessages, { role: "user", content: userText }];

      let accumulated = "";
      try {
        const full = await aiChat(
          { requestId, endpoint: config.endpoint, model: config.model, system, messages, maxTokens: null },
          (event) => {
            if (event.kind !== "delta" || requestIdRef.current !== requestId) return;
            accumulated += event.text;
            const snapshot = accumulated;
            setState((prev) => (prev.status === "streaming" ? { ...prev, text: snapshot } : prev));
          },
        );
        if (requestIdRef.current !== requestId) return; // superseded (closed/regenerated) meanwhile
        requestIdRef.current = null;
        setState({
          status: "result",
          mode,
          draft: "",
          messages: [...messages, { role: "assistant", content: full }],
          lastUserText: userText,
          text: full,
          error: null,
        });
      } catch (e) {
        if (requestIdRef.current !== requestId) return;
        requestIdRef.current = null;
        if (isCancelled(e)) {
          // A silent stop: back to an editable draft, not an error. A "fix" request has no
          // user-typed instruction (userText is the internal buildFixMessage prompt), so the draft
          // is left blank instead of exposing that prompt as if the user had typed it.
          setState({
            status: "prompting",
            mode,
            draft: mode.kind === "fix" ? "" : userText,
            messages: priorMessages,
            lastUserText: "",
            text: "",
            error: null,
          });
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        setState({
          status: "error",
          mode,
          draft: "",
          messages: priorMessages,
          lastUserText: userText,
          text: accumulated,
          error: message,
        });
      }
    },
    [aiAccess, connectionId, database, kind, serverVersion],
  );

  const openGenerate = useCallback(() => {
    const view = editorRef.current;
    const sel = view?.state.selection.main;
    const mode: AiAssistMode =
      sel && !sel.empty
        ? { kind: "selection", from: sel.from, to: sel.to, text: view?.state.sliceDoc(sel.from, sel.to) ?? "" }
        : { kind: "insert", pos: sel?.head ?? 0 };
    setState({ status: "prompting", mode, draft: "", messages: [], lastUserText: "", text: "", error: null });
  }, [editorRef]);

  const openFix = useCallback(
    ({ sql, error }: { sql: string; error: string }) => {
      const view = editorRef.current;
      const anchorPos = view?.state.selection.main.head ?? 0;
      const mode: AiAssistMode = { kind: "fix", anchorPos, sql, error };
      void runRequest(mode, [], buildFixMessage({ sql, error }));
    },
    [editorRef, runRequest],
  );

  const close = useCallback(() => {
    cancelRunning();
    requestIdRef.current = null;
    setState(CLOSED_STATE);
  }, [cancelRunning]);

  const setDraft = useCallback((text: string) => {
    setState((prev) => (prev.status === "prompting" || prev.status === "result" ? { ...prev, draft: text } : prev));
  }, []);

  const submit = useCallback(() => {
    const s = stateRef.current;
    if (s.status === "prompting" && s.mode) {
      const instruction = s.draft.trim();
      if (!instruction) return;
      const mode = s.mode;
      const userText =
        mode.kind === "selection"
          ? buildGenerateMessage({ instruction, selection: mode.text })
          : buildGenerateMessage({ instruction, editorText: editorRef.current?.state.doc.toString() });
      void runRequest(mode, [], userText);
    } else if (s.status === "result" && s.mode) {
      const followUp = s.draft.trim();
      if (!followUp) return;
      void runRequest(s.mode, s.messages, followUp);
    }
  }, [runRequest, editorRef]);

  const stop = useCallback(() => {
    cancelRunning();
  }, [cancelRunning]);

  const regenerate = useCallback(() => {
    const s = stateRef.current;
    if (s.status !== "result" || !s.mode) return;
    // s.messages ends with [..., user, assistant] for the answer being discarded.
    const prior = s.messages.slice(0, -2);
    void runRequest(s.mode, prior, s.lastUserText);
  }, [runRequest]);

  const retry = useCallback(() => {
    const s = stateRef.current;
    if (s.status !== "error" || !s.mode) return;
    void runRequest(s.mode, s.messages, s.lastUserText);
  }, [runRequest]);

  const accept = useCallback(() => {
    const s = stateRef.current;
    const view = editorRef.current;
    if (s.status !== "result" || !s.mode || !view) return;
    const sql = extractSql(s.text);
    const doc = view.state.doc.toString();

    const edit =
      s.mode.kind === "selection"
        ? acceptEditSelection(s.mode.from, s.mode.to, sql)
        : s.mode.kind === "fix"
          ? acceptFix(doc, s.mode.sql, s.mode.anchorPos, sql)
          : insertAtCursor(doc, s.mode.pos, sql);

    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: edit.selectionFrom, head: edit.selectionTo },
      scrollIntoView: true,
      userEvent: "input",
    });
    view.focus();
    setState(CLOSED_STATE);
  }, [editorRef]);

  const discard = useCallback(() => {
    close();
  }, [close]);

  return { state, openGenerate, openFix, close, setDraft, submit, stop, regenerate, retry, accept, discard };
}
