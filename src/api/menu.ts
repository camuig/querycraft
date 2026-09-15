// Bridge to the native application menu (Tauri only; no-op in the browser).
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ThemePreference } from "../store/settingsStore";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Event emitted by the backend when a menu item is activated; payload is the menu item id. */
export const MENU_EVENT = "app-menu";

export function onMenuAction(handler: (id: string) => void): Promise<UnlistenFn> {
  if (!isTauri) return Promise.resolve(() => undefined);
  return listen<string>(MENU_EVENT, (e) => handler(e.payload));
}

/** Keeps the "View → Theme" check marks in sync with the current preference. */
export function syncThemeMenu(theme: ThemePreference): Promise<void> {
  if (!isTauri) return Promise.resolve();
  return invoke<void>("set_theme_menu", { theme });
}
