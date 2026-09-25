// Resolves what the AI chat panel is currently talking about: the active tab's connection/database
// (console, table data or DDL tab), falling back to the explorer's selection when no tab is open —
// plus everything the header/composer need to know about that connection.

import type { AiAccess, DbKind, QueryLanguage } from "../../api/types";
import { dialectFor } from "../../lib/dialect";
import { selectConnectionAiAccess, selectConnectionKind, useConnectionsStore } from "../../store/connectionsStore";
import { useExplorerStore } from "../../store/explorerStore";
import type { ConsoleTab } from "../../store/tabsStore";
import { useTabsStore } from "../../store/tabsStore";

export interface ChatContextInfo {
  connectionId: string | null;
  connectionName: string | null;
  database: string | null;
  kind: DbKind;
  aiAccess: AiAccess;
  serverVersion: string | null;
  queryLanguage: QueryLanguage;
  /** The active tab, when it is a console for this same connection — enables "Include current query". */
  activeConsole: ConsoleTab | null;
}

export function useChatContext(): ChatContextInfo {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const explorerConnectionId = useExplorerStore((s) => s.selectedConnectionId);
  const explorerDatabase = useExplorerStore((s) => s.selectedDatabase);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const connectionId = activeTab ? activeTab.connectionId : explorerConnectionId;
  const database = activeTab ? (activeTab.database ?? null) : explorerDatabase;

  const kind = useConnectionsStore(selectConnectionKind(connectionId ?? ""));
  const aiAccess = useConnectionsStore(selectConnectionAiAccess(connectionId ?? ""));
  const serverVersion = useConnectionsStore((s) =>
    connectionId ? (s.runtime[connectionId]?.serverInfo?.serverVersion ?? null) : null,
  );
  const connectionName = useConnectionsStore((s) => s.configs.find((c) => c.id === connectionId)?.name ?? null);

  const activeConsole = activeTab?.kind === "console" && activeTab.connectionId === connectionId ? activeTab : null;

  return {
    connectionId,
    connectionName,
    database,
    kind,
    aiAccess,
    serverVersion,
    queryLanguage: dialectFor(kind).queryLanguage,
    activeConsole,
  };
}
