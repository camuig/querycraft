import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import * as api from "../../api/commands";
import type { ExecuteRequest, StatementResult } from "../../api/types";
import { registerCommand } from "../../lib/commandBus";
import { newId } from "../../lib/ids";
import { actionTitle } from "../../lib/keymap";
import { statementAtCursor } from "../../lib/sqlSplit";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useExplorerStore } from "../../store/explorerStore";
import { selectResolvedTheme, useSettingsStore } from "../../store/settingsStore";
import { useStatusStore } from "../../store/statusStore";
import type { ConsoleTab as ConsoleTabModel } from "../../store/tabsStore";
import { useTabsStore } from "../../store/tabsStore";
import { toast } from "../../store/toastStore";
import { ResultsPanel } from "../grid/ResultsPanel";
import { SqlEditor } from "./SqlEditor";

/** SQL console tab: toolbar (run / cancel / database), editor on top, results below. */
export function ConsoleTab({ tab, active }: { tab: ConsoleTabModel; active: boolean }) {
  const updateConsole = useTabsStore((s) => s.updateConsole);
  const connect = useConnectionsStore((s) => s.connect);
  const runtimeStatus = useConnectionsStore((s) => s.runtime[tab.connectionId]?.status ?? "disconnected");
  const databases = useExplorerStore((s) => s.databases[tab.connectionId]);
  const loadDatabases = useExplorerStore((s) => s.loadDatabases);
  const tables = useExplorerStore((s) => s.tables);
  const columnsCache = useExplorerStore((s) => s.columns);
  const loadTables = useExplorerStore((s) => s.loadTables);
  const loadColumns = useExplorerStore((s) => s.loadColumns);
  const maxRows = useSettingsStore((s) => s.maxRows);
  const editorFontSize = useSettingsStore((s) => s.editorFontSize);
  const theme = useSettingsStore(selectResolvedTheme);
  const setStatusMessage = useStatusStore((s) => s.setMessage);

  const editorRef = useRef<EditorView | null>(null);
  const [localSql, setLocalSql] = useState(tab.sql);
  const [results, setResults] = useState<StatementResult[]>([]);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const currentQueryId = useRef<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  // Persist the editor text to tabsStore with a delay so the store is not updated on every keystroke.
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => updateConsole(tab.id, { sql: localSql }), 300);
    return () => window.clearTimeout(saveTimer.current);
  }, [localSql, tab.id, updateConsole]);

  useEffect(() => {
    if (runtimeStatus === "connected") loadDatabases(tab.connectionId).catch(() => undefined);
  }, [runtimeStatus, tab.connectionId, loadDatabases]);

  // Tables of the current database plus (when there are not too many) their columns for autocomplete.
  useEffect(() => {
    if (!tab.database || runtimeStatus !== "connected") return;
    const db = tab.database;
    loadTables(tab.connectionId, db)
      .then((list) => {
        if (list.length <= 150) {
          for (const t of list) loadColumns(tab.connectionId, db, t.name).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, [tab.connectionId, tab.database, runtimeStatus, loadTables, loadColumns]);

  const schema = useMemo(() => {
    if (!tab.database) return undefined;
    const list = tables[`${tab.connectionId}/${tab.database}`] ?? [];
    const result: Record<string, string[]> = {};
    for (const t of list) {
      const cols = columnsCache[`${tab.connectionId}/${tab.database}/${t.name}`];
      result[t.name] = cols ? cols.map((c) => c.name) : [];
    }
    return result;
  }, [tables, columnsCache, tab.connectionId, tab.database]);

  const ensureConnected = useCallback(async () => {
    if (useConnectionsStore.getState().runtime[tab.connectionId]?.status !== "connected") {
      await connect(tab.connectionId);
    }
  }, [connect, tab.connectionId]);

  const runSql = useCallback(
    async (sql: string, rowsLimit: number, databaseOverride?: string | null) => {
      if (!sql.trim()) return;
      try {
        await ensureConnected();
      } catch (e) {
        toast.error(e);
        return;
      }
      const queryId = newId();
      currentQueryId.current = queryId;
      setRunning(true);
      const started = performance.now();
      try {
        const request: ExecuteRequest = {
          connectionId: tab.connectionId,
          sessionId: tab.sessionId,
          queryId,
          sql,
          maxRows: rowsLimit,
          database: databaseOverride !== undefined ? databaseOverride : tab.database,
          stopOnError: true,
        };
        const res = await api.executeQuery(request);
        setResults(res);
        const totalRows = res.reduce((sum, r) => sum + (r.kind === "rows" ? r.rows.length : r.affectedRows), 0);
        const totalMs = Math.round(performance.now() - started);
        setStatusMessage(`${totalRows} rows in ${totalMs} ms`);
        const firstError = res.find((r) => r.kind === "error");
        if (firstError) toast.error(firstError.error ?? "Execution error");
      } catch (e) {
        setResults([
          {
            sql,
            kind: "error",
            columns: [],
            rows: [],
            truncated: false,
            affectedRows: 0,
            lastInsertId: null,
            error: String(e),
            durationMs: 0,
          },
        ]);
        toast.error(e);
      } finally {
        setRunning(false);
        setElapsedMs(Math.round(performance.now() - started));
        currentQueryId.current = null;
      }
    },
    [ensureConnected, tab.connectionId, tab.sessionId, tab.database, setStatusMessage],
  );

  const handleExecute = useCallback(
    (mode: "current" | "all") => {
      const view = editorRef.current;
      const text = view ? view.state.doc.toString() : localSql;
      let sqlToRun: string;
      const sel = view?.state.selection.main;
      if (sel && !sel.empty) {
        sqlToRun = text.slice(sel.from, sel.to);
      } else if (mode === "all") {
        sqlToRun = text;
      } else {
        const pos = sel ? sel.head : text.length;
        const stmt = statementAtCursor(text, pos);
        sqlToRun = stmt ? stmt.sql : text;
      }
      void runSql(sqlToRun, maxRows);
    },
    [localSql, maxRows, runSql],
  );

  const handleCancel = useCallback(() => {
    if (currentQueryId.current) {
      api.cancelQuery(tab.connectionId, currentQueryId.current).catch(() => undefined);
    }
  }, [tab.connectionId]);

  // Menu items and global shortcuts reach the active console through the command bus.
  useEffect(() => {
    if (!active) return;
    const offs = [
      registerCommand("executeStatement", () => {
        if (running) return false;
        handleExecute("current");
      }),
      registerCommand("executeScript", () => {
        if (running) return false;
        handleExecute("all");
      }),
      registerCommand("cancelQuery", () => {
        if (!running) return false;
        handleCancel();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [active, running, handleExecute, handleCancel]);

  const handleLoadMore = useCallback(
    (index: number) => {
      const r = results[index];
      if (!r) return;
      void runSql(r.sql, Math.min(maxRows * 2, 20000));
    },
    [results, maxRows, runSql],
  );

  const handleDatabaseChange = useCallback(
    (db: string) => {
      updateConsole(tab.id, { database: db || null });
      if (db) void runSql(`USE \`${db}\``, 1, null);
    },
    [tab.id, updateConsole, runSql],
  );

  return (
    <div className="console-tab" style={{ display: active ? "flex" : "none" }}>
      <div className="console-toolbar">
        <button
          type="button"
          onClick={() => handleExecute("current")}
          disabled={running}
          title={actionTitle("executeStatement", "Run")}
        >
          ▶ Run
        </button>
        <button
          type="button"
          onClick={() => handleExecute("all")}
          disabled={running}
          title={actionTitle("executeScript", "Run all")}
        >
          ▶▶ Run all
        </button>
        {running && (
          <button type="button" onClick={handleCancel} title={actionTitle("cancelQuery", "Cancel")}>
            ■ Cancel
          </button>
        )}
        <div className="sep" />
        <select
          value={tab.database ?? ""}
          onChange={(e) => handleDatabaseChange(e.target.value)}
          title="Current database"
        >
          <option value="">(no database)</option>
          {(databases ?? []).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <div className="status">
          {running && <span className="spinner" />}
          <span>{running ? "Running…" : elapsedMs !== null ? `${elapsedMs} ms` : ""}</span>
        </div>
      </div>
      <div className="console-split">
        <Group orientation="vertical" id="console-split">
          <Panel defaultSize="60%" minSize="15%">
            <SqlEditor
              value={localSql}
              onChange={setLocalSql}
              onExecute={handleExecute}
              schema={schema}
              fontSize={editorFontSize}
              theme={theme}
              editorRef={editorRef}
            />
          </Panel>
          <Separator className="resize-handle horizontal" />
          <Panel minSize="15%">
            <ResultsPanel results={results} onLoadMore={handleLoadMore} />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
