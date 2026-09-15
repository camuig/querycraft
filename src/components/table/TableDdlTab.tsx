import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useState } from "react";
import * as api from "../../api/commands";
import { useConnectionsStore } from "../../store/connectionsStore";
import { selectResolvedTheme, useSettingsStore } from "../../store/settingsStore";
import type { DdlTab as DdlTabModel } from "../../store/tabsStore";
import { toast } from "../../store/toastStore";
import { SqlEditor } from "../editor/SqlEditor";

/** Table DDL (SHOW CREATE TABLE) — read-only, with a copy button. */
export function TableDdlTab({ tab, active }: { tab: DdlTabModel; active: boolean }) {
  const connect = useConnectionsStore((s) => s.connect);
  const theme = useSettingsStore(selectResolvedTheme);
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
    toast.success("Copied to clipboard");
  }

  return (
    <div className="ddl-tab" style={{ display: active ? "flex" : "none" }}>
      <div className="ddl-toolbar">
        <button className="outline" onClick={() => void handleCopy()} disabled={!ddl}>
          Copy
        </button>
        {loading && <span className="muted">Loading…</span>}
      </div>
      <div className="ddl-body">
        <SqlEditor
          value={ddl}
          onChange={() => undefined}
          onExecute={() => undefined}
          readOnly
          fontSize={fontSize}
          theme={theme}
        />
      </div>
    </div>
  );
}
