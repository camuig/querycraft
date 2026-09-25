import { useEffect } from "react";
import { onMenuAction } from "../../api/menu";
import { dispatchCommand, registerCommand } from "../../lib/commandBus";
import { type AppAction, actionsForEvent, detectPlatform } from "../../lib/keymap";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useExplorerStore } from "../../store/explorerStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useTabsStore } from "../../store/tabsStore";
import { useUpdateStore } from "../../store/updateStore";

/** Actions that are safe to trigger while the focus is inside a text field or the SQL editor. */
const ALLOWED_IN_TEXT_FIELDS = new Set<AppAction>([
  "executeStatement",
  "executeScript",
  "cancelQuery",
  "newConsole",
  "newConnection",
  "refresh",
  "submitChanges",
  "revertChanges",
  "nextPage",
  "prevPage",
  "closeTab",
  "nextTab",
  "prevTab",
  "focusExplorer",
  "openSettings",
  "aiGenerate",
]);

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
    return true;
  return target.isContentEditable;
}

/**
 * Wires the DataGrip-style keymap and the native menu to the command bus and
 * registers the application-level commands (tabs, console, settings).
 */
export function useAppCommands() {
  const platform = detectPlatform();

  useEffect(() => {
    const offs = [
      registerCommand("openSettings", () => useSettingsStore.getState().openDialog()),
      registerCommand("checkForUpdates", () => void useUpdateStore.getState().check(true)),
      registerCommand("newConnection", () => useConnectionsStore.getState().openDialog("new")),
      registerCommand("newConsole", () => {
        const explorer = useExplorerStore.getState();
        const cid = explorer.selectedConnectionId;
        if (!cid || useConnectionsStore.getState().runtime[cid]?.status !== "connected") return false;
        useTabsStore.getState().openConsole(cid, explorer.selectedDatabase);
      }),
      registerCommand("closeTab", () => {
        const { activeTabId, closeTab } = useTabsStore.getState();
        if (!activeTabId) return false;
        closeTab(activeTabId);
      }),
      registerCommand("nextTab", () => useTabsStore.getState().activateSibling(1)),
      registerCommand("prevTab", () => useTabsStore.getState().activateSibling(-1)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // A component (editor, grid, dialog) already consumed the key.
      if (e.defaultPrevented) return;
      const actions = actionsForEvent(e, platform);
      if (actions.length === 0) return;
      const inText = isTextField(e.target);
      for (const action of actions) {
        if (inText && !ALLOWED_IN_TEXT_FIELDS.has(action)) continue;
        if (dispatchCommand(action, platform)) {
          e.preventDefault();
          return;
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [platform]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onMenuAction((id) => {
      if (id.startsWith("theme:")) {
        useSettingsStore.getState().setTheme(id.slice("theme:".length) as "system" | "light" | "dark");
        return;
      }
      dispatchCommand(id as AppAction, platform);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [platform]);
}
