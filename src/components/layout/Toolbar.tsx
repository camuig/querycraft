import { useCallback, useEffect } from "react";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useExplorerStore } from "../../store/explorerStore";
import { useTabsStore } from "../../store/tabsStore";
import { useSettingsStore } from "../../store/settingsStore";

const MAX_ROWS_OPTIONS = [100, 500, 1000, 5000];

/** Верхний тулбар в духе DataGrip: подключения, новая консоль, тема, лимит строк. */
export function Toolbar() {
  const openConnectionDialog = useConnectionsStore((s) => s.openDialog);
  const selectedConnectionId = useExplorerStore((s) => s.selectedConnectionId);
  const selectedDatabase = useExplorerStore((s) => s.selectedDatabase);
  const connectionStatus = useConnectionsStore((s) =>
    selectedConnectionId ? s.runtime[selectedConnectionId]?.status : undefined,
  );
  const openConsole = useTabsStore((s) => s.openConsole);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const maxRows = useSettingsStore((s) => s.maxRows);
  const setMaxRows = useSettingsStore((s) => s.setMaxRows);

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
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNewConsole]);

  return (
    <div className="toolbar">
      <button className="outline" onClick={() => openConnectionDialog("new")} title="Новое подключение">
        + Подключение
      </button>
      <button
        onClick={handleNewConsole}
        disabled={!canOpenConsole}
        title="Новая консоль (⌘/Ctrl+Shift+N)"
      >
        ▤ Новая консоль
      </button>
      <div className="sep" />
      <button
        className="icon"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
      <div className="spacer" />
      <label className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
        Лимит строк
        <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}>
          {MAX_ROWS_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
