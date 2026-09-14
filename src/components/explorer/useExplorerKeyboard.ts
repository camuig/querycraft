import { useCallback } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { TreeNode } from "./treeModel";

const SELECTABLE_KINDS = new Set<TreeNode["kind"]>(["loading", "error"]);

interface Params {
  nodes: TreeNode[];
  expanded: Record<string, boolean>;
  selectedKey: string | null;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  onSelect: (node: TreeNode) => void;
  onToggleExpand: (node: TreeNode) => void;
  onCollapse: (node: TreeNode) => void;
  onDefaultAction: (node: TreeNode) => void;
}

/** Навигация по дереву с клавиатуры: ↑/↓ — выбор, ←/→ — свернуть/развернуть, Enter — действие по умолчанию. */
export function useExplorerKeyboard({
  nodes,
  expanded,
  selectedKey,
  virtualizer,
  onSelect,
  onToggleExpand,
  onCollapse,
  onDefaultAction,
}: Params) {
  return useCallback(
    (e: React.KeyboardEvent) => {
      const selectable = nodes.map((_n, i) => i).filter((i) => !SELECTABLE_KINDS.has(nodes[i].kind));
      const curIdx = nodes.findIndex((n) => n.key === selectedKey);
      const posInSelectable = selectable.indexOf(curIdx);

      function go(node: TreeNode) {
        onSelect(node);
        const idx = nodes.findIndex((n) => n.key === node.key);
        if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
      }

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const nextPos = posInSelectable < 0 ? 0 : Math.min(selectable.length - 1, posInSelectable + 1);
          const nextNode = nodes[selectable[nextPos]];
          if (nextNode) go(nextNode);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prevPos = posInSelectable <= 0 ? 0 : posInSelectable - 1;
          const prevNode = nodes[selectable[prevPos]];
          if (prevNode) go(prevNode);
          break;
        }
        case "ArrowRight": {
          if (curIdx < 0) break;
          const node = nodes[curIdx];
          if (node.expandable && !expanded[node.key]) {
            e.preventDefault();
            onToggleExpand(node);
          }
          break;
        }
        case "ArrowLeft": {
          if (curIdx < 0) break;
          const node = nodes[curIdx];
          if (node.expandable && expanded[node.key]) {
            e.preventDefault();
            onCollapse(node);
          }
          break;
        }
        case "Enter": {
          if (curIdx < 0) break;
          e.preventDefault();
          onDefaultAction(nodes[curIdx]);
          break;
        }
        default:
          break;
      }
    },
    [nodes, expanded, selectedKey, virtualizer, onSelect, onToggleExpand, onCollapse, onDefaultAction],
  );
}
