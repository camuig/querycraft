import { TreeRow } from "./TreeRow";
import { ContextMenu } from "./ContextMenu";
import { useExplorerTree } from "./useExplorerTree";
import "../../styles/explorer.css";

/** Левая панель "Проводник БД": подключения → базы → таблицы/представления → столбцы/индексы/ключи. */
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

  return (
    <div className="panel">
      <div className="panel-header">
        <span>База данных</span>
        <div style={{ flex: 1 }} />
        <button className="icon" onClick={() => openConnectionDialog("new")} title="Новое подключение">
          +
        </button>
        <button
          className="icon"
          onClick={handleRefreshSelected}
          disabled={!explorer.selectedConnectionId}
          title="Обновить"
        >
          ↻
        </button>
      </div>
      <div className="explorer-filter">
        <input
          placeholder="Фильтр…"
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
