import { Group, Panel, Separator } from "react-resizable-panels";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSettingsStore } from "../../store/settingsStore";
import { ChatPanel } from "../ai/ChatPanel";
import { Toasts } from "../common/Toasts";
import { ConnectionDialog } from "../connections/ConnectionDialog";
import { ExplorerPanel } from "../explorer/ExplorerPanel";
import { SettingsDialog } from "../settings/SettingsDialog";
import { StatusBar } from "./StatusBar";
import { TabContent } from "./TabContent";
import { TabsBar } from "./TabsBar";
import { Toolbar } from "./Toolbar";
import { useAppCommands } from "./useAppCommands";

/** Application frame: toolbar on top, explorer / tabs / AI chat in the middle, status bar at the bottom. */
export function AppShell() {
  const dialog = useConnectionsStore((s) => s.dialog);
  const settingsOpen = useSettingsStore((s) => s.dialogOpen);
  const aiChatOpen = useSettingsStore((s) => s.aiChatOpen);
  const aiChatWidth = useSettingsStore((s) => s.aiChatWidth);
  const setAiChatWidth = useSettingsStore((s) => s.setAiChatWidth);
  useAppCommands();
  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        <Group
          orientation="horizontal"
          id="main-layout"
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction && typeof layout["ai-chat"] === "number") {
              setAiChatWidth(layout["ai-chat"]);
            }
          }}
        >
          <Panel id="explorer" defaultSize="22%" minSize="12%" maxSize="50%">
            <ExplorerPanel />
          </Panel>
          <Separator className="resize-handle vertical" />
          <Panel id="tabs" minSize="30%">
            <div className="tab-content" style={{ height: "100%" }}>
              <TabsBar />
              <TabContent />
            </div>
          </Panel>
          {aiChatOpen && (
            <>
              <Separator className="resize-handle vertical" />
              <Panel id="ai-chat" defaultSize={`${aiChatWidth}%`} minSize="18%" maxSize="50%">
                <ChatPanel />
              </Panel>
            </>
          )}
        </Group>
      </div>
      <StatusBar />
      {dialog !== null && <ConnectionDialog />}
      {settingsOpen && <SettingsDialog />}
      <Toasts />
    </div>
  );
}
