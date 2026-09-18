import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../api/commands";
import type { CellValue, ColumnMeta, ParamStatement } from "../../api/types";
import { ChangeTracker, countChanges } from "../../lib/changeTracker";
import { registerCommand } from "../../lib/commandBus";
import { newId } from "../../lib/ids";
import { type AppAction, actionsForEvent, actionTitle, detectPlatform } from "../../lib/keymap";
import { KEY_TYPE_GLYPH, keyMatchPattern, quoteRedisKey } from "../../lib/redisCommands";
import { buildKeyStatements, keyEditCapabilities, keyLoadCommand, withListIndexColumn } from "../../lib/redisKeyEditor";
import { selectConnectionKind, useConnectionsStore } from "../../store/connectionsStore";
import { dbKey, useExplorerStore } from "../../store/explorerStore";
import type { KeyDataTab as KeyDataTabModel } from "../../store/tabsStore";
import { useTabsStore } from "../../store/tabsStore";
import { toast } from "../../store/toastStore";
import { DataGrid } from "../grid/DataGrid";
import type { GridCellPos } from "../grid/useGridSelection";

/** How long "Delete key" stays armed after the first click before it needs pressing again. */
const DELETE_CONFIRM_MS = 3000;

function selectStatement(database: string): ParamStatement {
  return { sql: "SELECT", params: [database] };
}

/** Redis key data: the whole value in a grid shaped by `TYPE`, TTL control, deferred commit. */
export function KeyDataTab({ tab, active }: { tab: KeyDataTabModel; active: boolean }) {
  const connect = useConnectionsStore((s) => s.connect);
  const kind = useConnectionsStore(selectConnectionKind(tab.connectionId));
  const closeTab = useTabsStore((s) => s.closeTab);

  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [rows, setRows] = useState<CellValue[][]>([]);
  const [tracker, setTracker] = useState<ChangeTracker | null>(null);
  const [loading, setLoading] = useState(false);
  const [ttl, setTtl] = useState<number | null>(null);
  const [ttlInput, setTtlInput] = useState("");
  const [selectedCell, setSelectedCell] = useState<GridCellPos | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const deleteTimerRef = useRef<number | undefined>(undefined);

  const capabilities = keyEditCapabilities(tab.keyType);

  useEffect(() => () => window.clearTimeout(deleteTimerRef.current), []);

  const ensureConnected = useCallback(async () => {
    if (useConnectionsStore.getState().runtime[tab.connectionId]?.status !== "connected") {
      await connect(tab.connectionId);
    }
  }, [connect, tab.connectionId]);

  // Load the key's full value plus its TTL.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken forces a refetch on demand
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await ensureConnected();
        const sql = `${keyLoadCommand(tab.key, tab.keyType)}\nTTL ${quoteRedisKey(tab.key)}`;
        const res = await api.executeQuery({
          connectionId: tab.connectionId,
          sessionId: tab.sessionId,
          queryId: newId(),
          sql,
          maxRows: 5000,
          database: tab.database,
          stopOnError: false,
        });
        if (cancelled) return;

        const valueResult = res[0];
        if (!valueResult || valueResult.kind === "error") {
          toast.error(valueResult?.error ?? "Failed to load key");
          setColumns([]);
          setRows([]);
        } else if (valueResult.kind === "rows") {
          if (tab.keyType === "list") {
            const withIndex = withListIndexColumn(valueResult.columns, valueResult.rows);
            setColumns(withIndex.columns);
            setRows(withIndex.rows);
          } else {
            setColumns(valueResult.columns);
            setRows(valueResult.rows);
          }
        } else {
          setColumns([]);
          setRows([]);
        }

        const ttlResult = res[1];
        const ttlCell = ttlResult?.kind === "rows" ? (ttlResult.rows[0]?.[0] ?? null) : null;
        const ttlNumber = typeof ttlCell === "number" ? ttlCell : Number(ttlCell);
        setTtl(Number.isFinite(ttlNumber) && ttlNumber >= 0 ? ttlNumber : null);
      } catch (e) {
        if (!cancelled) toast.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab.connectionId, tab.sessionId, tab.database, tab.key, tab.keyType, reloadToken, ensureConnected]);

  // Rebuild the change tracker on every new data load.
  useEffect(() => {
    setTracker(new ChangeTracker(rows, columns, [], kind));
    setSelectedCell(null);
  }, [rows, columns, kind]);

  useEffect(() => {
    setTtlInput(ttl !== null ? String(ttl) : "");
  }, [ttl]);

  const editable = capabilities.cellEdit;
  const changeCount = tracker ? countChanges(tracker, tracker.rows.length, columns.length) : 0;

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  // Lengths and counts in the explorer are stale after a submit or a delete: drop the cached
  // listing and, when the database is expanded, reload it in place so the tree does not collapse.
  const invalidateExplorerKeys = useCallback(() => {
    const explorer = useExplorerStore.getState();
    const key = dbKey(tab.connectionId, tab.database);
    explorer.invalidate(key);
    if (explorer.expanded[key]) {
      void explorer
        .loadKeys(tab.connectionId, tab.database, keyMatchPattern(explorer.filter), true)
        .catch(() => undefined);
    }
  }, [tab.connectionId, tab.database]);

  const handleEditCell = useCallback(
    (r: number, c: number, v: CellValue) => {
      if (columns[c]?.binary) return;
      setTracker((t) => t?.setCell(r, c, v) ?? t);
    },
    [columns],
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
    setSelectedCell({ row: rowIndex, col: columns.findIndex((c) => !c.binary) });
  }, [tracker, columns]);

  const handleToggleDeleteSelected = useCallback(() => {
    if (!tracker || !selectedCell) return;
    const r = selectedCell.row;
    setTracker(tracker.isDeleted(r) ? tracker.undeleteRow(r) : tracker.deleteRow(r));
  }, [tracker, selectedCell]);

  const handleRevert = useCallback(() => {
    setTracker((t) => t?.revertAll() ?? t);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!tracker?.hasChanges) return;
    const result = buildKeyStatements(tab.database, tab.key, tab.keyType, rows, tracker, columns);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    try {
      const applied = await api.applyChanges(tab.connectionId, tab.sessionId, result.statements);
      toast.success(`Applied. Affected: ${applied.affectedRows}`);
      invalidateExplorerKeys();
      reload();
    } catch (e) {
      toast.error(e);
    }
  }, [tracker, rows, columns, tab, invalidateExplorerKeys, reload]);

  const handleApplyTtl = useCallback(async () => {
    const seconds = Number(ttlInput);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      toast.error("TTL must be a positive whole number of seconds");
      return;
    }
    try {
      await api.applyChanges(tab.connectionId, tab.sessionId, [
        selectStatement(tab.database),
        { sql: "EXPIRE", params: [tab.key, seconds] },
      ]);
      toast.success("TTL updated");
      reload();
    } catch (e) {
      toast.error(e);
    }
  }, [ttlInput, tab, reload]);

  const handlePersist = useCallback(async () => {
    try {
      await api.applyChanges(tab.connectionId, tab.sessionId, [
        selectStatement(tab.database),
        { sql: "PERSIST", params: [tab.key] },
      ]);
      toast.success("TTL removed");
      reload();
    } catch (e) {
      toast.error(e);
    }
  }, [tab, reload]);

  const handleDeleteKeyConfirmed = useCallback(async () => {
    try {
      await api.applyChanges(tab.connectionId, tab.sessionId, [
        selectStatement(tab.database),
        { sql: "DEL", params: [tab.key] },
      ]);
      toast.success("Key deleted");
      invalidateExplorerKeys();
      closeTab(tab.id);
    } catch (e) {
      toast.error(e);
    }
  }, [tab, invalidateExplorerKeys, closeTab]);

  const handleDeleteKeyClick = useCallback(() => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      window.clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = window.setTimeout(() => setConfirmingDelete(false), DELETE_CONFIRM_MS);
      return;
    }
    window.clearTimeout(deleteTimerRef.current);
    setConfirmingDelete(false);
    void handleDeleteKeyConfirmed();
  }, [confirmingDelete, handleDeleteKeyConfirmed]);

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
          if (!capabilities.canInsert) return false;
          handleAddRow();
          return true;
        case "deleteRow":
          if (!capabilities.canDelete || !selectedCell) return false;
          handleToggleDeleteSelected();
          return true;
        case "refresh":
          reload();
          return true;
        default:
          return false;
      }
    },
    [tracker, handleSubmit, handleRevert, capabilities, handleAddRow, selectedCell, handleToggleDeleteSelected, reload],
  );

  // Native menu items and application-wide shortcuts target the active tab through the command bus.
  useEffect(() => {
    if (!active) return;
    const actions: AppAction[] = ["submitChanges", "revertChanges", "addRow", "deleteRow", "refresh"];
    const offs = actions.map((action) =>
      registerCommand(action, () => {
        if (action === "refresh" && document.activeElement?.closest("[data-explorer]")) return false;
        return runAction(action);
      }),
    );
    return () => {
      for (const off of offs) off();
    };
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

  const readOnlyHint = useMemo(() => {
    if (capabilities.cellEdit) return null;
    return `Editing is not supported for ${tab.keyType} keys`;
  }, [capabilities.cellEdit, tab.keyType]);

  return (
    <div className="table-data-tab" style={{ display: active ? "flex" : "none" }}>
      <div className="table-toolbar">
        <button type="button" className="icon" onClick={reload} title={actionTitle("refresh", "Reload")}>
          ↻
        </button>
        <span className="tree-icon tree-icon-type muted" title={tab.keyType}>
          {KEY_TYPE_GLYPH[tab.keyType] ?? "?"}
        </span>
        <span className="muted">{tab.keyType}</span>
        <span className="muted">TTL:</span>
        <input
          type="number"
          min={1}
          style={{ width: 90 }}
          value={ttlInput}
          placeholder="no expiry"
          onChange={(e) => setTtlInput(e.target.value)}
        />
        <span className="muted">s</span>
        <button type="button" onClick={() => void handleApplyTtl()}>
          Apply
        </button>
        <button type="button" onClick={() => void handlePersist()} disabled={ttl === null}>
          Persist
        </button>
        <div className="spacer" />
        {readOnlyHint && <span className="muted">{readOnlyHint}</span>}
        <span className="muted">changes: {changeCount}</span>
        <button
          type="button"
          className="icon"
          onClick={handleAddRow}
          disabled={!capabilities.canInsert}
          title={actionTitle("addRow")}
        >
          +
        </button>
        <button
          type="button"
          className="icon"
          onClick={handleToggleDeleteSelected}
          disabled={!capabilities.canDelete || !selectedCell}
          title={actionTitle("deleteRow", "Delete / restore row")}
        >
          −
        </button>
        <button
          type="button"
          onClick={handleRevert}
          disabled={!tracker?.hasChanges}
          title={actionTitle("revertChanges")}
        >
          Revert
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void handleSubmit()}
          disabled={!tracker?.hasChanges}
          title={actionTitle("submitChanges")}
        >
          Submit
        </button>
        <button type="button" className={confirmingDelete ? "danger" : ""} onClick={handleDeleteKeyClick}>
          {confirmingDelete ? "Confirm delete" : "Delete key"}
        </button>
      </div>

      <div className="table-body">
        <DataGrid
          columns={columns}
          rows={tracker ? tracker.rows : rows}
          editable={editable}
          onEditCell={handleEditCell}
          cellClass={cellClass}
          selectedCell={selectedCell}
          onSelectCell={setSelectedCell}
          onKeyDown={handleGridKeyDown}
        />
      </div>

      <div className="table-footer">
        <span>{tab.key}</span>
        {loading && <span className="muted">Loading…</span>}
      </div>
    </div>
  );
}
