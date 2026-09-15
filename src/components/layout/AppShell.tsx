import { Group, Panel, Separator } from "react-resizable-panels";
import { Toolbar } from "./Toolbar";
import { StatusBar } from "./StatusBar";
import { TabsBar } from "./TabsBar";
import { TabContent } from "./TabContent";
import { ExplorerPanel } from "../explorer/ExplorerPanel";
import { ConnectionDialog } from "../connections/ConnectionDialog";
import { useSettingsStore } from "../../store/settingsStore";
import { SettingsDialog } from "../settings/SettingsDialog";
import { Toasts } from "../common/Toasts";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useAppCommands } from "./useAppCommands";

/** Application frame: toolbar on top, explorer on the left, tabs in the centre, status bar at the bottom. */
export function AppShell() {
  const dialog = useConnectionsStore((s) => s.dialog);
  const settingsOpen = useSettingsStore((s) => s.dialogOpen);
  useAppCommands();
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
      {settingsOpen && <SettingsDialog />}
      <Toasts />
    </div>
  );
}
