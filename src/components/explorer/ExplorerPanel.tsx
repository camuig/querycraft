import { useEffect } from "react";
import { registerCommand } from "../../lib/commandBus";
import { NO_AUTOCORRECT } from "../../lib/inputProps";
import { actionTitle } from "../../lib/keymap";
import { ContextMenu } from "./ContextMenu";
import { TreeRow } from "./TreeRow";
import { useExplorerTree } from "./useExplorerTree";
import "../../styles/explorer.css";

/** Left "Database" panel: connections → databases → tables/views → columns/indexes/keys. */
export function ExplorerPanel() {
  const {
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
  } = useExplorerTree();

  useEffect(() => {
    const offs = [
      registerCommand("focusExplorer", () => parentRef.current?.focus()),
      registerCommand("refresh", () => {
        if (!explorer.selectedConnectionId) return false;
        handleRefreshSelected();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [parentRef, explorer.selectedConnectionId, handleRefreshSelected]);

  return (
    <div className="panel" data-explorer>
      <div className="panel-header">
        <span>Database</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="icon" onClick={() => openConnectionDialog("new")} title="New connection">
          +
        </button>
        <button
          type="button"
          className="icon"
          onClick={handleRefreshSelected}
          disabled={!explorer.selectedConnectionId}
          title={actionTitle("refresh")}
        >
          ↻
        </button>
      </div>
      <div className="explorer-filter">
        <input
          {...NO_AUTOCORRECT}
          placeholder="Filter…"
          value={explorer.filter}
          onChange={(e) => explorer.setFilter(e.target.value)}
        />
      </div>
      <div className="explorer-list" ref={parentRef} tabIndex={0} onKeyDown={handleKeyDown}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const node = nodes[vi.index];
            return (
              <TreeRow
                key={node.key}
                node={node}
                selected={node.key === explorer.selectedKey}
                expanded={!!explorer.expanded[node.key]}
                style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}
                onSelect={() => handleSelect(node)}
                onToggleExpand={() => handleToggleExpand(node)}
                onDoubleClick={() => handleDefaultAction(node)}
                onContextMenu={(e) => handleContextMenu(e, node)}
              />
            );
          })}
        </div>
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextMenuItems(contextMenu.node) ?? []}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
