import type { CSSProperties } from "react";
import type { TreeNode } from "./treeModel";

const KIND_ICON: Partial<Record<TreeNode["kind"], string>> = {
  database: "🗄",
  "group-tables": "📁",
  "group-views": "📁",
  table: "▦",
  view: "◫",
  "group-columns": "📁",
  "group-indexes": "📁",
  "group-fks": "📁",
  index: "◆",
  fk: "⛓",
};

interface TreeRowProps {
  node: TreeNode;
  selected: boolean;
  expanded: boolean;
  style: CSSProperties;
  onSelect: () => void;
  onToggleExpand: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/** Одна строка дерева проводника: отступ, шеврон, иконка, название, доп. текст справа. */
export function TreeRow({ node, selected, expanded, style, onSelect, onToggleExpand, onDoubleClick, onContextMenu }: TreeRowProps) {
  const isPlain = node.kind === "loading" || node.kind === "error";

  return (
    <div
      data-node-key={node.key}
      className={`tree-row ${selected ? "selected" : ""} ${node.kind === "error" ? "danger" : ""}`}
      style={{ ...style, paddingLeft: 8 + node.depth * 16 }}
      onClick={!isPlain ? onSelect : undefined}
      onDoubleClick={!isPlain ? onDoubleClick : undefined}
      onContextMenu={!isPlain ? onContextMenu : undefined}
      title={node.title}
    >
      {node.expandable ? (
        <span
          className="tree-chevron"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
        >
          {expanded ? "▾" : "▸"}
        </span>
      ) : (
        <span className="tree-chevron" />
      )}

      {node.kind === "connection" && (
        <>
          {node.colorHex && <span className="tree-dot" style={{ background: node.colorHex }} />}
          <span className="tree-dot" style={{ background: node.statusColor }} />
        </>
      )}

      {KIND_ICON[node.kind] && <span className="tree-icon">{KIND_ICON[node.kind]}</span>}
      {node.keyGlyph && <span className="tree-icon" title={node.keyGlyph === "🔑" ? "primary key" : "index"}>{node.keyGlyph}</span>}

      <span className={`tree-label ${node.bold ? "tree-label-bold" : ""} ${isPlain ? "muted" : ""}`}>{node.label}</span>

      {node.secondary && <span className="tree-secondary muted">{node.secondary}</span>}
    </div>
  );
}
