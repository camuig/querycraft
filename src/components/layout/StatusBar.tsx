import { useTabsStore } from "../../store/tabsStore";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useStatusStore } from "../../store/statusStore";
import type { ConnectionStatus } from "../../store/connectionsStore";

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connected: "var(--success)",
  connecting: "var(--warning)",
  error: "var(--danger)",
  disconnected: "var(--fg-dim)",
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: "connected",
  connecting: "connecting…",
  error: "error",
  disconnected: "disconnected",
};

/** Bottom status bar: active tab's connection/database on the left, server version on the right. */
export function StatusBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const connectionId = activeTab?.connectionId ?? null;
  const database = activeTab && "database" in activeTab ? activeTab.database : null;

  const config = useConnectionsStore((s) => (connectionId ? s.configs.find((c) => c.id === connectionId) : undefined));
  const runtime = useConnectionsStore((s) => (connectionId ? s.runtime[connectionId] : undefined));
  const message = useStatusStore((s) => s.message);

  const status = runtime?.status ?? "disconnected";

  return (
    <div className="statusbar">
      {activeTab ? (
        <>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: STATUS_COLOR[status], flexShrink: 0 }} />
          <span>{config?.name ?? "?"}</span>
          {database && <span className="muted">/ {database}</span>}
          <span className="muted">{STATUS_LABEL[status]}</span>
        </>
      ) : (
        <span className="muted">No active tab</span>
      )}
      <div className="spacer" />
      {message && <span className="text-select">{message}</span>}
      <div className="spacer" />
      {runtime?.status === "connected" && runtime.serverInfo && (
        <span className="muted">MySQL {runtime.serverInfo.serverVersion}</span>
      )}
    </div>
  );
}
