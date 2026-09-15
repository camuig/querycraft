/**
 * Tiny command bus that connects keyboard shortcuts and the native menu with
 * whatever component is currently able to handle an action.
 *
 * Components register handlers while mounted/active; the most recently
 * registered handler is tried first. A handler returns `false` to decline, in
 * which case the next one is tried. Because several actions can share a key
 * (Cmd+Enter is both "execute" and "submit changes"), dispatch also tries the
 * other actions bound to the same shortcut.
 */
import { type AppAction, actionsSharingShortcut, detectPlatform, type Platform } from "./keymap";

export type CommandHandler = () => boolean | void;

const handlers = new Map<AppAction, CommandHandler[]>();

/** Registers a handler; returns the unregister function (use in a `useEffect` cleanup). */
export function registerCommand(action: AppAction, handler: CommandHandler): () => void {
  const list = handlers.get(action) ?? [];
  list.push(handler);
  handlers.set(action, list);
  return () => {
    const cur = handlers.get(action);
    if (!cur) return;
    const i = cur.lastIndexOf(handler);
    if (i >= 0) cur.splice(i, 1);
  };
}

function runAction(action: AppAction): boolean {
  const list = handlers.get(action);
  if (!list) return false;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]() !== false) return true;
  }
  return false;
}

/** Runs the action (or any action sharing its shortcut). Returns whether something handled it. */
export function dispatchCommand(action: AppAction, platform: Platform = detectPlatform()): boolean {
  if (runAction(action)) return true;
  for (const other of actionsSharingShortcut(action, platform)) {
    if (other !== action && runAction(other)) return true;
  }
  return false;
}

/** Test helper: drops every registered handler. */
export function resetCommandBus(): void {
  handlers.clear();
}
