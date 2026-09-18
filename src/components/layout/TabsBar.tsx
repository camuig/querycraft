import { useConnectionsStore } from "../../store/connectionsStore";
import { useTabsStore } from "../../store/tabsStore";

const icons: Record<string, string> = { console: "▤", table: "▦", ddl: "{ }", key: "⏵" };

export function TabsBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActive = useTabsStore((s) => s.setActive);
  const closeTab = useTabsStore((s) => s.closeTab);
  const configs = useConnectionsStore((s) => s.configs);

  if (tabs.length === 0) return null;
  return (
    <div className="tabs-bar">
      {tabs.map((t) => {
        const conn = configs.find((c) => c.id === t.connectionId);
        return (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? "active" : ""}`}
            onClick={() => setActive(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id);
            }}
            title={conn ? `${conn.name}${"database" in t && t.database ? ` / ${t.database}` : ""}` : undefined}
          >
            {conn?.color && (
              <span style={{ width: 8, height: 8, borderRadius: 4, background: conn.color, flexShrink: 0 }} />
            )}
            <span className="muted" style={{ fontSize: 11 }}>
              {icons[t.kind]}
            </span>
            <span>{t.title}</span>
            <span
              className="close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              ✕
            </span>
          </div>
        );
      })}
    </div>
  );
}
