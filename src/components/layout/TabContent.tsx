import { useTabsStore } from "../../store/tabsStore";
import { ConsoleTab } from "../editor/ConsoleTab";
import { TableDataTab } from "../table/TableDataTab";
import { TableDdlTab } from "../table/TableDdlTab";
import { Logo } from "../common/Logo";

/** Рендерит все вкладки, скрывая неактивные (чтобы сохранять состояние редактора и гридов). */
export function TabContent() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);

  if (tabs.length === 0) {
    return (
      <div className="empty-state">
        <Logo size={56} style={{ color: "var(--fg)" }} />
        <div style={{ fontSize: 15 }}>QueryCraft</div>
        <div>Select a connection in the explorer on the left or create a new one.</div>
        <div>
          Open a console: <kbd>⌘/Ctrl</kbd> + <kbd>⇧</kbd> + <kbd>N</kbd>
        </div>
      </div>
    );
  }

  return (
    <>
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div key={tab.id} className="tab-content" style={{ display: active ? "flex" : "none" }}>
            {tab.kind === "console" && <ConsoleTab tab={tab} active={active} />}
            {tab.kind === "table" && <TableDataTab tab={tab} active={active} />}
            {tab.kind === "ddl" && <TableDdlTab tab={tab} active={active} />}
          </div>
        );
      })}
    </>
  );
}
