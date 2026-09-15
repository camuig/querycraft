import { useVirtualizer } from "@tanstack/react-virtual";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useMemo, useRef, useState } from "react";
import { type ConnectionStatus, useConnectionsStore } from "../../store/connectionsStore";
import { dbKey, tableKey, useExplorerStore } from "../../store/explorerStore";
import { useTabsStore } from "../../store/tabsStore";
import { toast } from "../../store/toastStore";
import type { ContextMenuEntry } from "./ContextMenu";
import { buildTree, type TreeNode } from "./treeModel";
import { useExplorerKeyboard } from "./useExplorerKeyboard";

export const ROW_HEIGHT = 22;

/** All explorer tree logic: data, visible nodes, virtualization, handlers. */
export function useExplorerTree() {
  const connections = useConnectionsStore((s) => s.configs);
  const runtime = useConnectionsStore((s) => s.runtime);
  const connect = useConnectionsStore((s) => s.connect);
  const disconnect = useConnectionsStore((s) => s.disconnect);
  const openConnectionDialog = useConnectionsStore((s) => s.openDialog);

  const explorer = useExplorerStore();
  const openConsole = useTabsStore((s) => s.openConsole);
  const openTableData = useTabsStore((s) => s.openTableData);
  const openDdl = useTabsStore((s) => s.openDdl);
  const closeTabsForConnection = useTabsStore((s) => s.closeTabsForConnection);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);

  const runtimeStatus = useMemo(() => {
    const out: Record<string, ConnectionStatus> = {};
    for (const c of connections) out[c.id] = runtime[c.id]?.status ?? "disconnected";
    return out;
  }, [connections, runtime]);

  const nodes = useMemo(
    () =>
      buildTree({
        connections,
        runtimeStatus,
        databases: explorer.databases,
        tables: explorer.tables,
        columns: explorer.columns,
        indexes: explorer.indexes,
        foreignKeys: explorer.foreignKeys,
        loading: explorer.loading,
        errors: explorer.errors,
        expanded: explorer.expanded,
        filter: explorer.filter,
      }),
    [
      connections,
      runtimeStatus,
      explorer.databases,
      explorer.tables,
      explorer.columns,
      explorer.indexes,
      explorer.foreignKeys,
      explorer.loading,
      explorer.errors,
      explorer.expanded,
      explorer.filter,
    ],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const handleSelect = useCallback(
    (node: TreeNode) => explorer.selectNode(node.key, node.connectionId, node.database ?? null),
    [explorer],
  );

  const loadNodeData = useCallback(
    async (node: TreeNode) => {
      try {
        switch (node.kind) {
          case "connection": {
            if (runtimeStatus[node.connectionId] !== "connected") {
              try {
                await connect(node.connectionId);
              } catch (e) {
                toast.error(e);
                return;
              }
            }
            await explorer.loadDatabases(node.connectionId);
            break;
          }
          case "database":
            await explorer.loadTables(node.connectionId, node.database!);
            break;
          case "table":
          case "view":
            await explorer.loadColumns(node.connectionId, node.database!, node.table!);
            break;
          case "group-indexes":
            await explorer.loadIndexes(node.connectionId, node.database!, node.table!);
            break;
          case "group-fks":
            await explorer.loadForeignKeys(node.connectionId, node.database!, node.table!);
            break;
          default:
            break;
        }
      } catch {
        // the error is already stored in explorerStore.errors and will render in the tree
      }
    },
    [connect, explorer, runtimeStatus],
  );

  const handleToggleExpand = useCallback(
    (node: TreeNode) => {
      const isExpanded = !!explorer.expanded[node.key];
      explorer.toggle(node.key, !isExpanded);
      if (!isExpanded) void loadNodeData(node);
    },
    [explorer, loadNodeData],
  );

  const handleDefaultAction = useCallback(
    (node: TreeNode) => {
      switch (node.kind) {
        case "table":
        case "view":
          openTableData(node.connectionId, node.database!, node.table!);
          break;
        case "connection":
        case "database":
        case "group-tables":
        case "group-views":
        case "group-indexes":
        case "group-fks":
          handleToggleExpand(node);
          break;
        default:
          break;
      }
    },
    [openTableData, handleToggleExpand],
  );

  const handleRefreshNode = useCallback(
    (node: TreeNode) => {
      switch (node.kind) {
        case "connection":
          explorer.invalidate(node.connectionId);
          if (explorer.expanded[node.connectionId]) void explorer.loadDatabases(node.connectionId, true);
          break;
        case "database": {
          const key = dbKey(node.connectionId, node.database!);
          explorer.invalidate(key);
          if (explorer.expanded[key]) void explorer.loadTables(node.connectionId, node.database!, true);
          break;
        }
        case "table":
        case "view": {
          const key = tableKey(node.connectionId, node.database!, node.table!);
          explorer.invalidate(key);
          if (explorer.expanded[key]) void explorer.loadColumns(node.connectionId, node.database!, node.table!, true);
          break;
        }
        default:
          break;
      }
    },
    [explorer],
  );

  const handleRefreshSelected = useCallback(() => {
    const cid = explorer.selectedConnectionId;
    if (!cid) return;
    explorer.invalidate(cid);
    if (explorer.expanded[cid]) void explorer.loadDatabases(cid, true);
  }, [explorer]);

  const handleConnect = useCallback(
    async (cid: string) => {
      try {
        await connect(cid);
        await explorer.loadDatabases(cid);
        explorer.toggle(cid, true);
      } catch (e) {
        toast.error(e);
      }
    },
    [connect, explorer],
  );

  const handleDisconnect = useCallback(
    async (cid: string) => {
      try {
        await disconnect(cid);
        closeTabsForConnection(cid);
      } catch (e) {
        toast.error(e);
      }
    },
    [disconnect, closeTabsForConnection],
  );

  const copyName = useCallback((name: string) => {
    void writeText(name).catch(() => undefined);
  }, []);

  const buildContextMenuItems = useCallback(
    (node: TreeNode): ContextMenuEntry[] | null => {
      switch (node.kind) {
        case "connection": {
          const connected = runtimeStatus[node.connectionId] === "connected";
          return [
            connected
              ? { label: "Disconnect", onClick: () => void handleDisconnect(node.connectionId) }
              : { label: "Connect", onClick: () => void handleConnect(node.connectionId) },
            { label: "New console", onClick: () => openConsole(node.connectionId, null), disabled: !connected },
            "divider",
            { label: "Edit…", onClick: () => openConnectionDialog(node.connectionId) },
            { label: "Refresh", onClick: () => handleRefreshNode(node) },
            { label: "Delete", onClick: () => openConnectionDialog(node.connectionId) },
          ];
        }
        case "database":
          return [
            { label: "New console", onClick: () => openConsole(node.connectionId, node.database!) },
            { label: "Refresh", onClick: () => handleRefreshNode(node) },
            { label: "Copy name", onClick: () => copyName(node.database!) },
          ];
        case "table":
        case "view":
          return [
            { label: "Open data", onClick: () => openTableData(node.connectionId, node.database!, node.table!) },
            { label: "DDL", onClick: () => openDdl(node.connectionId, node.database!, node.table!) },
            {
              label: "New console",
              onClick: () =>
                openConsole(
                  node.connectionId,
                  node.database!,
                  `SELECT * FROM \`${node.database}\`.\`${node.table}\` LIMIT 500;`,
                ),
            },
            "divider",
            { label: "Copy name", onClick: () => copyName(node.table!) },
            { label: "Refresh", onClick: () => handleRefreshNode(node) },
          ];
        default:
          return null;
      }
    },
    [
      runtimeStatus,
      handleDisconnect,
      handleConnect,
      openConsole,
      openConnectionDialog,
      handleRefreshNode,
      copyName,
      openTableData,
      openDdl,
    ],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: TreeNode) => {
      const items = buildContextMenuItems(node);
      if (!items) return;
      e.preventDefault();
      handleSelect(node);
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    },
    [buildContextMenuItems, handleSelect],
  );

  const handleKeyDown = useExplorerKeyboard({
    nodes,
    expanded: explorer.expanded,
    selectedKey: explorer.selectedKey,
    virtualizer,
    onSelect: handleSelect,
    onToggleExpand: handleToggleExpand,
    onCollapse: (node) => explorer.toggle(node.key, false),
    onDefaultAction: handleDefaultAction,
    onOpenData: (node) => openTableData(node.connectionId, node.database!, node.table!),
    onOpenDdl: (node) => openDdl(node.connectionId, node.database!, node.table!),
  });

  return {
    explorer,
    nodes,
    parentRef,
    virtualizer,
    contextMenu,
    setContextMenu,
    openConnectionDialog,
    handleSelect,
    handleToggleExpand,
    handleDefaultAction,
    handleRefreshSelected,
    handleContextMenu,
    handleKeyDown,
    buildContextMenuItems,
  };
}
