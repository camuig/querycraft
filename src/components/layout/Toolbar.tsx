import { useCallback, useEffect } from "react";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useExplorerStore } from "../../store/explorerStore";
import { useTabsStore } from "../../store/tabsStore";
import { MAX_ROWS_OPTIONS, useSettingsStore } from "../../store/settingsStore";
import { Logo } from "../common/Logo";

/** Верхний тулбар в духе DataGrip: подключения, новая консоль, лимит строк, настройки. */
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

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleNewConsole();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        openSettings();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNewConsole, openSettings]);

  return (
    <div className="toolbar">
      <div className="brand" title="QueryCraft">
        <Logo size={18} />
      </div>
      <button className="outline" onClick={() => openConnectionDialog("new")} title="New connection">
        + Connection
      </button>
      <button onClick={handleNewConsole} disabled={!canOpenConsole} title="New console (⌘/Ctrl+Shift+N)">
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
      <button className="icon" onClick={openSettings} title="Settings (⌘/Ctrl+,)">
        ⚙
      </button>
    </div>
  );
}
