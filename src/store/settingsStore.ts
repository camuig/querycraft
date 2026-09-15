import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The theme actually applied. */
export type ResolvedTheme = "dark" | "light";
/** User preference: "system" means follow the OS setting. */
export type ThemePreference = ResolvedTheme | "system";

export const MAX_ROWS_OPTIONS = [100, 500, 1000, 5000];
export const MIN_EDITOR_FONT_SIZE = 10;
export const MAX_EDITOR_FONT_SIZE = 24;

interface SettingsState {
  theme: ThemePreference;
  /** Whether the system theme is dark (updated via matchMedia in App). Not persisted. */
  systemDark: boolean;
  /** Row limit per result. */
  maxRows: number;
  editorFontSize: number;
  /** Whether the settings dialog is open. Not persisted. */
  dialogOpen: boolean;
  setTheme: (theme: ThemePreference) => void;
  setSystemDark: (dark: boolean) => void;
  setMaxRows: (n: number) => void;
  setEditorFontSize: (n: number) => void;
  openDialog: () => void;
  closeDialog: () => void;
}

function readSystemDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      systemDark: readSystemDark(),
      maxRows: 500,
      editorFontSize: 13,
      dialogOpen: false,
      setTheme: (theme) => set({ theme }),
      setSystemDark: (systemDark) => set({ systemDark }),
      setMaxRows: (maxRows) => set({ maxRows }),
      setEditorFontSize: (editorFontSize) =>
        set({
          editorFontSize: Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Math.round(editorFontSize))),
        }),
      openDialog: () => set({ dialogOpen: true }),
      closeDialog: () => set({ dialogOpen: false }),
    }),
    {
      name: "querycraft-settings",
      partialize: (s) => ({ theme: s.theme, maxRows: s.maxRows, editorFontSize: s.editorFontSize }),
    },
  ),
);

/** Selector for the resolved theme, accounting for "system" mode. */
export const selectResolvedTheme = (s: Pick<SettingsState, "theme" | "systemDark">): ResolvedTheme =>
  s.theme === "system" ? (s.systemDark ? "dark" : "light") : s.theme;
