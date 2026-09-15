import { useCallback } from "react";
import { actionTitle } from "../../lib/keymap";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useExplorerStore } from "../../store/explorerStore";
import { MAX_ROWS_OPTIONS, useSettingsStore } from "../../store/settingsStore";
import { useTabsStore } from "../../store/tabsStore";
import { Logo } from "../common/Logo";

/** Top toolbar in the spirit of DataGrip: connections, new console, row limit, settings. */
export function Toolbar() {
  const openConnectionDialog = useConnectionsStore((s) => s.openDialog);
  const selectedConnectionId = useExplorerStore((s) => s.selectedConnectionId);
  const selectedDatabase = useExplorerStore((s) => s.selectedDatabase);
  const connectionStatus = useConnectionsStore((s) =>
    selectedConnectionId ? s.runtime[selectedConnectionId]?.status : undefined,
  );
  const openConsole = useTabsStore((s) => s.openConsole);
  const maxRows = useSettingsStore((s) => s.maxRows);
  const setMaxRows = useSettingsStore((s) => s.setMaxRows);
  const openSettings = useSettingsStore((s) => s.openDialog);

  const canOpenConsole = selectedConnectionId !== null && connectionStatus === "connected";

  const handleNewConsole = useCallback(() => {
    if (!selectedConnectionId || connectionStatus !== "connected") return;
    openConsole(selectedConnectionId, selectedDatabase);
  }, [selectedConnectionId, connectionStatus, selectedDatabase, openConsole]);

  return (
    <div className="toolbar">
      <div className="brand" title="QueryCraft">
        <Logo size={18} />
      </div>
      <button type="button" className="outline" onClick={() => openConnectionDialog("new")} title="New connection">
        + Connection
      </button>
      <button
        type="button"
        onClick={handleNewConsole}
        disabled={!canOpenConsole}
        title={actionTitle("newConsole", "New console")}
      >
        ▤ New console
      </button>
      <div className="spacer" />
      <label className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
        Row limit
        <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}>
          {MAX_ROWS_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="icon" onClick={openSettings} title={actionTitle("openSettings")}>
        ⚙
      </button>
    </div>
  );
}
