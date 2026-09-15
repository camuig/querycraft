import type { Virtualizer } from "@tanstack/react-virtual";
import { useCallback } from "react";
import { actionsForEvent, detectPlatform } from "../../lib/keymap";
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
  onOpenData: (node: TreeNode) => void;
  onOpenDdl: (node: TreeNode) => void;
}

/**
 * Keyboard navigation for the tree: ↑/↓ select, ←/→ collapse/expand, Enter runs the default action,
 * F4 opens table data and Cmd/Ctrl+B opens the DDL (DataGrip keymap).
 */
export function useExplorerKeyboard({
  nodes,
  expanded,
  selectedKey,
  virtualizer,
  onSelect,
  onToggleExpand,
  onCollapse,
  onDefaultAction,
  onOpenData,
  onOpenDdl,
}: Params) {
  return useCallback(
    (e: React.KeyboardEvent) => {
      const current = nodes.find((n) => n.key === selectedKey);
      if (current && (current.kind === "table" || current.kind === "view")) {
        const actions = actionsForEvent(e, detectPlatform());
        if (actions.includes("openTableData")) {
          e.preventDefault();
          onOpenData(current);
          return;
        }
        if (actions.includes("goToDdl")) {
          e.preventDefault();
          onOpenDdl(current);
          return;
        }
      }

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
    [
      nodes,
      expanded,
      selectedKey,
      virtualizer,
      onSelect,
      onToggleExpand,
      onCollapse,
      onDefaultAction,
      onOpenData,
      onOpenDdl,
    ],
  );
}
