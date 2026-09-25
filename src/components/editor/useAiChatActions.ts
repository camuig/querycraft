// Console-side glue for "Explain query" / "Optimize query": picks the target statement the same way
// Run does (selection, else the statement at the cursor), sends the corresponding chat message to the
// AI chat panel and opens it. Optimize additionally runs the dialect's EXPLAIN (never ANALYZE, and
// never the statement itself) through the console's own session first, so the message includes a real
// execution plan; the statement/plan-building logic itself lives in `lib/ai/explain.ts` and
// `lib/ai/prompts.ts` — this hook only wires it to the console's editor and session.

import type { EditorView } from "@codemirror/view";
import { useCallback, useState } from "react";
import * as api from "../../api/commands";
import type { AiAccess, DbKind } from "../../api/types";
import { buildExplainDisplay, buildOptimizeDisplay } from "../../lib/ai/chat";
import { explainSqlFor, formatResultAsText } from "../../lib/ai/explain";
import { buildExplainMessage, buildOptimizeMessage } from "../../lib/ai/prompts";
import { dialectFor } from "../../lib/dialect";
import { newId } from "../../lib/ids";
import { statementAtCursor } from "../../lib/sqlSplit";
import { useAiChatStore } from "../../store/aiChatStore";
import { useSettingsStore } from "../../store/settingsStore";
import { toast } from "../../store/toastStore";

export interface UseAiChatActionsOptions {
  connectionId: string;
  database: string | null;
  sessionId: string;
  kind: DbKind;
  aiAccess: AiAccess;
  serverVersion?: string | null;
  editorRef: React.MutableRefObject<EditorView | null>;
}

export interface AiChatActionsApi {
  explain: () => void;
  optimize: () => void;
  /** True while the EXPLAIN for "Optimize query" is running — shown as a busy state on the button. */
  optimizing: boolean;
}

function targetStatement(view: EditorView | null, kind: DbKind): string | null {
  if (!view) return null;
  const sel = view.state.selection.main;
  if (!sel.empty) return view.state.sliceDoc(sel.from, sel.to);
  const stmt = statementAtCursor(view.state.doc.toString(), sel.head, { dollarQuoting: kind === "postgres" });
  return stmt?.sql ?? null;
}

export function useAiChatActions(opts: UseAiChatActionsOptions): AiChatActionsApi {
  const { connectionId, database, sessionId, kind, aiAccess, serverVersion, editorRef } = opts;
  const [optimizing, setOptimizing] = useState(false);

  const explain = useCallback(() => {
    const sql = targetStatement(editorRef.current, kind)?.trim();
    if (!sql) {
      toast.error("No statement to explain");
      return;
    }
    useSettingsStore.getState().setAiChatOpen(true);
    useAiChatStore
      .getState()
      .send(
        { connectionId, database, kind, aiAccess, serverVersion },
        buildExplainMessage({ sql }),
        buildExplainDisplay(sql),
      );
  }, [editorRef, kind, connectionId, database, aiAccess, serverVersion]);

  const runOptimize = useCallback(async () => {
    const sql = targetStatement(editorRef.current, kind)?.trim();
    if (!sql) {
      toast.error("No statement to optimize");
      return;
    }

    const explainSql = explainSqlFor(kind, sql, serverVersion);
    let plan: string | null = null;
    let planError: string | null = null;

    if (!explainSql) {
      planError = `EXPLAIN is not available for ${dialectFor(kind).label}`;
    } else {
      setOptimizing(true);
      try {
        const [result] = await api.executeQuery({
          connectionId,
          sessionId,
          queryId: newId(),
          sql: explainSql,
          maxRows: 500,
          database,
          stopOnError: true,
        });
        if (result?.kind === "error") planError = result.error ?? "EXPLAIN failed";
        else if (result) plan = formatResultAsText(result);
        else planError = "EXPLAIN returned no result";
      } catch (e) {
        planError = e instanceof Error ? e.message : String(e);
      } finally {
        setOptimizing(false);
      }
    }

    useSettingsStore.getState().setAiChatOpen(true);
    useAiChatStore
      .getState()
      .send(
        { connectionId, database, kind, aiAccess, serverVersion, includeIndexes: true },
        buildOptimizeMessage({ sql, plan, planError }),
        buildOptimizeDisplay(sql),
      );
  }, [editorRef, kind, serverVersion, connectionId, sessionId, database, aiAccess]);

  const optimize = useCallback(() => void runOptimize(), [runOptimize]);

  return { explain, optimize, optimizing };
}
