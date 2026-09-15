import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../../api/commands";
import type { CellValue, ColumnMeta } from "../../api/types";
import { ChangeTracker } from "../../lib/changeTracker";
import { registerCommand } from "../../lib/commandBus";
import { newId } from "../../lib/ids";
import { type AppAction, actionsForEvent, actionTitle, detectPlatform } from "../../lib/keymap";
import { buildSelect, type OrderBySpec, qualify, sqlLiteral } from "../../lib/sqlBuilder";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useExplorerStore } from "../../store/explorerStore";
import { selectResolvedTheme, useSettingsStore } from "../../store/settingsStore";
import type { TableDataTab as TableDataTabModel } from "../../store/tabsStore";
import { toast } from "../../store/toastStore";
import { SqlEditor } from "../editor/SqlEditor";
import { DataGrid } from "../grid/DataGrid";
import type { GridCellPos } from "../grid/useGridSelection";
import { WhereInput } from "./WhereInput";

function countChanges(tracker: ChangeTracker, rowCount: number, colCount: number): number {
  let n = 0;
  for (let r = 0; r < rowCount; r++) {
    if (tracker.isDeleted(r) || tracker.isInserted(r)) {
      n++;
      continue;
    }
    for (let c = 0; c < colCount; c++) {
      if (tracker.isModified(r, c)) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** Table data: pagination, WHERE filter, sorting, editing with deferred commit. */
export function TableDataTab({ tab, active }: { tab: TableDataTabModel; active: boolean }) {
  const connect = useConnectionsStore((s) => s.connect);
  const loadColumns = useExplorerStore((s) => s.loadColumns);
  const pageSize = useSettingsStore((s) => s.maxRows);
  const editorFontSize = useSettingsStore((s) => s.editorFontSize);
  const theme = useSettingsStore(selectResolvedTheme);

  const [pkColumns, setPkColumns] = useState<string[] | null>(null);
  const [columnNames, setColumnNames] = useState<string[]>([]);
  const [resultColumns, setResultColumns] = useState<ColumnMeta[]>([]);
  const [rows, setRows] = useState<CellValue[][]>([]);
  const [tracker, setTracker] = useState<ChangeTracker | null>(null);
  const [loading, setLoading] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [whereInput, setWhereInput] = useState("");
  const [whereApplied, setWhereApplied] = useState("");
  const [orderBy, setOrderBy] = useState<OrderBySpec[]>([]);
  const [selectedCell, setSelectedCell] = useState<GridCellPos | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const ensureConnected = useCallback(async () => {
    if (useConnectionsStore.getState().runtime[tab.connectionId]?.status !== "connected") {
      await connect(tab.connectionId);
    }
  }, [connect, tab.connectionId]);

  // Column metadata (used to determine the primary key).
  useEffect(() => {
    setPkColumns(null);
    setColumnNames([]);
    loadColumns(tab.connectionId, tab.database, tab.table)
      .then((cols) => {
        setColumnNames(cols.map((c) => c.name));
        setPkColumns(cols.filter((c) => c.key === "PRI").map((c) => c.name));
      })
      .catch((e) => {
        toast.error(e);
        setPkColumns([]);
      });
  }, [tab.connectionId, tab.database, tab.table, loadColumns]);

  // Load a page of data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await ensureConnected();
        const sql = buildSelect({
          database: tab.database,
          table: tab.table,
          where: whereApplied,
          orderBy,
          limit: pageSize,
          offset: page * pageSize,
        });
        const res = await api.executeQuery({
          connectionId: tab.connectionId,
          sessionId: tab.sessionId,
          queryId: newId(),
          sql,
          maxRows: pageSize,
          database: tab.database,
          stopOnError: true,
        });
        if (cancelled) return;
        const r = res[0];
        if (!r || r.kind === "error") {
          toast.error(r?.error ?? "Query execution error");
          setResultColumns([]);
          setRows([]);
        } else {
          setResultColumns(r.columns);
          setRows(r.rows);
        }
      } catch (e) {
        if (!cancelled) toast.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    tab.connectionId,
    tab.sessionId,
    tab.database,
    tab.table,
    whereApplied,
    orderBy,
    page,
    pageSize,
    reloadToken,
    ensureConnected,
  ]);

  // Approximate total row count (COUNT(*), run in parallel, doesn't block the grid).
  useEffect(() => {
    let cancelled = false;
    setTotalCount(null);
    (async () => {
      try {
        await ensureConnected();
        const whereSql = whereApplied.trim() ? ` WHERE (${whereApplied})` : "";
        const sql = `SELECT COUNT(*) AS cnt FROM ${qualify(tab.database, tab.table)}${whereSql}`;
        const res = await api.executeQuery({
          connectionId: tab.connectionId,
          sessionId: tab.sessionId,
          queryId: newId(),
          sql,
          maxRows: 1,
          database: tab.database,
          stopOnError: true,
        });
        const r = res[0];
        if (!cancelled && r?.kind === "rows" && r.rows[0]) {
          const v = r.rows[0][0];
          setTotalCount(typeof v === "number" ? v : Number(v));
        }
      } catch {
        // COUNT can be slow/unavailable — just leave "…"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab.connectionId, tab.sessionId, tab.database, tab.table, whereApplied, reloadToken, ensureConnected]);

  // Rebuild the change tracker on every new data load.
  useEffect(() => {
    setTracker(new ChangeTracker(rows, resultColumns, pkColumns ?? []));
    setSelectedCell(null);
  }, [rows, resultColumns, pkColumns]);

  const editable = (pkColumns?.length ?? 0) > 0;
  const changeCount = tracker ? countChanges(tracker, tracker.rows.length, resultColumns.length) : 0;

  const sort = useMemo(() => {
    if (orderBy.length === 0) return null;
    const idx = resultColumns.findIndex((c) => c.name === orderBy[0].column);
    return idx >= 0 ? { column: idx, dir: orderBy[0].dir } : null;
  }, [orderBy, resultColumns]);

  const handleSort = useCallback(
    (colIndex: number) => {
      const name = resultColumns[colIndex]?.name;
      if (!name) return;
      setOrderBy((prev) => {
        const cur = prev[0];
        if (!cur || cur.column !== name) return [{ column: name, dir: "asc" }];
        if (cur.dir === "asc") return [{ column: name, dir: "desc" }];
        return [];
      });
      setPage(0);
    },
    [resultColumns],
  );

  const handleEditCell = useCallback(
    (r: number, c: number, v: CellValue) => {
      if (resultColumns[c]?.binary) return;
      setTracker((t) => t?.setCell(r, c, v) ?? t);
    },
    [resultColumns],
  );

  const cellClass = useCallback(
    (r: number, c: number): string | undefined => {
      if (!tracker) return undefined;
      if (tracker.isDeleted(r)) return "cell-deleted";
      if (tracker.isInserted(r)) return "cell-inserted";
      if (tracker.isModified(r, c)) return "cell-modified";
      return undefined;
    },
    [tracker],
  );

  const handleAddRow = useCallback(() => {
    if (!tracker) return;
    const { tracker: next, rowIndex } = tracker.insertRow();
    setTracker(next);
    setSelectedCell({ row: rowIndex, col: 0 });
  }, [tracker]);

  /**
   * Paste a matrix of values starting at (row, col): each clipboard row maps to a grid row,
   * missing rows are appended as new ones (like in DataGrip).
   */
  const handlePaste = useCallback(
    (row: number, col: number, values: CellValue[][]) => {
      if (!tracker) return;
      let next = tracker;
      let added = 0;
      for (let i = 0; i < values.length; i++) {
        let r = row + i;
        if (r >= next.rows.length) {
          const ins = next.insertRow();
          next = ins.tracker;
          r = ins.rowIndex;
          added++;
        }
        const line = values[i];
        for (let j = 0; j < line.length; j++) {
          const c = col + j;
          if (c >= resultColumns.length) break;
          if (resultColumns[c]?.binary) continue;
          next = next.setCell(r, c, line[j]);
        }
      }
      setTracker(next);
      setSelectedCell({ row, col });
      if (added > 0) toast.info(`Added rows: ${added}. Press Submit to save.`);
    },
    [tracker, resultColumns],
  );

  const handleToggleDeleteSelected = useCallback(() => {
    if (!tracker || !selectedCell) return;
    const r = selectedCell.row;
    setTracker(tracker.isDeleted(r) ? tracker.undeleteRow(r) : tracker.deleteRow(r));
  }, [tracker, selectedCell]);

  const handleRevert = useCallback(() => {
    setTracker((t) => t?.revertAll() ?? t);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!tracker || !tracker.hasChanges) return;
    if (!editable) {
      toast.error("Table has no primary key — saving is disabled");
      return;
    }
    try {
      const statements = tracker.buildStatements(tab.database, tab.table);
      const result = await api.applyChanges(tab.connectionId, tab.sessionId, statements);
      toast.success(`Applied. Affected rows: ${result.affectedRows}`);
      setReloadToken((t2) => t2 + 1);
    } catch (e) {
      toast.error(e);
    }
  }, [tracker, editable, tab.database, tab.table, tab.connectionId, tab.sessionId]);

  const rangeStart = page * pageSize + 1;
  const rangeEnd = page * pageSize + rows.length;
  const canNext = totalCount !== null ? rangeEnd < totalCount : rows.length === pageSize;

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  /** Runs a keymap action against this tab; returns false when it does not apply. */
  const runAction = useCallback(
    (action: AppAction): boolean => {
      switch (action) {
        case "submitChanges":
          if (!tracker?.hasChanges) return false;
          void handleSubmit();
          return true;
        case "revertChanges":
          if (!tracker?.hasChanges) return false;
          handleRevert();
          return true;
        case "addRow":
          if (!editable) return false;
          handleAddRow();
          return true;
        case "deleteRow":
          if (!editable || !selectedCell) return false;
          handleToggleDeleteSelected();
          return true;
        case "refresh":
          reload();
          return true;
        case "nextPage":
          if (!canNext) return false;
          setPage((p) => p + 1);
          return true;
        case "prevPage":
          if (page === 0) return false;
          setPage((p) => Math.max(0, p - 1));
          return true;
        default:
          return false;
      }
    },
    [
      tracker,
      handleSubmit,
      handleRevert,
      editable,
      handleAddRow,
      selectedCell,
      handleToggleDeleteSelected,
      reload,
      canNext,
      page,
    ],
  );

  // Native menu items and application-wide shortcuts target the active tab through the command bus.
  useEffect(() => {
    if (!active) return;
    const actions: AppAction[] = [
      "submitChanges",
      "revertChanges",
      "addRow",
      "deleteRow",
      "refresh",
      "nextPage",
      "prevPage",
    ];
    const offs = actions.map((action) =>
      registerCommand(action, () => {
        // "Refresh" with the focus in the explorer belongs to the explorer.
        if (action === "refresh" && document.activeElement?.closest("[data-explorer]")) return false;
        return runAction(action);
      }),
    );
    return () => offs.forEach((off) => off());
  }, [active, runAction]);

  const handleGridKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      for (const action of actionsForEvent(e, detectPlatform())) {
        if (runAction(action)) {
          e.preventDefault();
          return;
        }
      }
    },
    [runAction],
  );

  const sqlPreview = useMemo(() => {
    if (!tracker || !tracker.hasChanges) return "";
    try {
      return tracker
        .buildStatements(tab.database, tab.table)
        .map((s) => {
          let i = 0;
          return s.sql.replace(/\?/g, () => sqlLiteral(s.params[i++])) + ";";
        })
        .join("\n");
    } catch (e) {
      return `-- ${String(e)}`;
    }
  }, [tracker, tab.database, tab.table]);

  return (
    <div className="table-data-tab" style={{ display: active ? "flex" : "none" }}>
      <div className="table-toolbar">
        <button className="icon" onClick={reload} title={actionTitle("refresh", "Reload page")}>
          ↻
        </button>
        <WhereInput
          value={whereInput}
          onChange={setWhereInput}
          onApply={() => {
            setWhereApplied(whereInput);
            setPage(0);
          }}
          columns={columnNames}
          placeholder="WHERE condition, e.g. id > 10"
        />
        {orderBy.map((o) => (
          <span key={o.column} className="order-chip">
            {o.column} {o.dir === "asc" ? "▲" : "▼"}
            <span className="close" onClick={() => setOrderBy([])}>
              ✕
            </span>
          </span>
        ))}
        <div className="spacer" />
        {!editable && pkColumns !== null && <span className="muted">Table has no primary key — read only</span>}
        <span className="muted">changes: {changeCount}</span>
        <button className="outline" onClick={() => setShowSql((s) => !s)}>
          {showSql ? "Hide SQL" : "Show SQL"}
        </button>
        <button className="icon" onClick={handleAddRow} disabled={!editable} title={actionTitle("addRow")}>
          +
        </button>
        <button
          className="icon"
          onClick={handleToggleDeleteSelected}
          disabled={!editable || !selectedCell}
          title={actionTitle("deleteRow", "Delete / restore row")}
        >
          −
        </button>
        <button onClick={handleRevert} disabled={!tracker?.hasChanges} title={actionTitle("revertChanges")}>
          Revert
        </button>
        <button
          className="primary"
          onClick={() => void handleSubmit()}
          disabled={!tracker?.hasChanges}
          title={actionTitle("submitChanges")}
        >
          Submit
        </button>
      </div>

      <div className="table-body">
        <DataGrid
          columns={resultColumns}
          rows={tracker ? tracker.rows : rows}
          editable={editable}
          onEditCell={handleEditCell}
          onPaste={handlePaste}
          cellClass={cellClass}
          selectedCell={selectedCell}
          onSelectCell={setSelectedCell}
          sort={sort}
          onSort={handleSort}
          onKeyDown={handleGridKeyDown}
        />
      </div>

      {showSql && (
        <div className="table-sql-preview">
          <SqlEditor
            value={sqlPreview}
            onChange={() => undefined}
            onExecute={() => undefined}
            readOnly
            fontSize={editorFontSize}
            theme={theme}
          />
        </div>
      )}

      <div className="table-footer">
        <button
          className="icon"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          title={actionTitle("prevPage")}
        >
          ◀
        </button>
        <span>
          Rows {rows.length > 0 ? rangeStart : 0}–{rangeEnd} of {totalCount === null ? "…" : totalCount}
        </span>
        <button
          className="icon"
          disabled={!canNext}
          onClick={() => setPage((p) => p + 1)}
          title={actionTitle("nextPage")}
        >
          ▶
        </button>
        {loading && <span className="muted">Loading…</span>}
      </div>
    </div>
  );
}
