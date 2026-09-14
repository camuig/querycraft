import { Group, Panel, Separator } from "react-resizable-panels";
import { Toolbar } from "./Toolbar";
import { StatusBar } from "./StatusBar";
import { TabsBar } from "./TabsBar";
import { TabContent } from "./TabContent";
import { ExplorerPanel } from "../explorer/ExplorerPanel";
import { ConnectionDialog } from "../connections/ConnectionDialog";
import { Toasts } from "../common/Toasts";
import { useConnectionsStore } from "../../store/connectionsStore";

/** Каркас: тулбар сверху, проводник слева, вкладки по центру, статус-бар снизу. */
export function AppShell() {
  const dialog = useConnectionsStore((s) => s.dialog);
  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        <Group orientation="horizontal" id="main-layout">
          <Panel defaultSize="22%" minSize="12%" maxSize="50%">
            <ExplorerPanel />
          </Panel>
          <Separator className="resize-handle vertical" />
          <Panel minSize="30%">
            <div className="tab-content" style={{ height: "100%" }}>
              <TabsBar />
              <TabContent />
            </div>
          </Panel>
        </Group>
      </div>
      <StatusBar />
      {dialog !== null && <ConnectionDialog />}
      <Toasts />
    </div>
  );
}
