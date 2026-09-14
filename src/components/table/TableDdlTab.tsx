import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { DdlTab as DdlTabModel } from "../../store/tabsStore";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSettingsStore } from "../../store/settingsStore";
import { toast } from "../../store/toastStore";
import * as api from "../../api/commands";
import { SqlEditor } from "../editor/SqlEditor";

/** DDL таблицы (SHOW CREATE TABLE) — только чтение, с кнопкой копирования. */
export function TableDdlTab({ tab, active }: { tab: DdlTabModel; active: boolean }) {
  const connect = useConnectionsStore((s) => s.connect);
  const theme = useSettingsStore((s) => s.theme);
  const fontSize = useSettingsStore((s) => s.editorFontSize);
  const [ddl, setDdl] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (useConnectionsStore.getState().runtime[tab.connectionId]?.status !== "connected") {
          await connect(tab.connectionId);
        }
        const text = await api.getTableDdl(tab.connectionId, tab.database, tab.table);
        if (!cancelled) setDdl(text);
      } catch (e) {
        if (!cancelled) toast.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab.connectionId, tab.database, tab.table, connect]);

  async function handleCopy() {
    try {
      await writeText(ddl);
    } catch {
      await navigator.clipboard?.writeText(ddl).catch(() => undefined);
    }
    toast.success("Скопировано в буфер обмена");
  }

  return (
    <div className="ddl-tab" style={{ display: active ? "flex" : "none" }}>
      <div className="ddl-toolbar">
        <button className="outline" onClick={() => void handleCopy()} disabled={!ddl}>
          Копировать
        </button>
        {loading && <span className="muted">Загрузка…</span>}
      </div>
      <div className="ddl-body">
        <SqlEditor value={ddl} onChange={() => undefined} onExecute={() => undefined} readOnly fontSize={fontSize} theme={theme} />
      </div>
    </div>
  );
}
