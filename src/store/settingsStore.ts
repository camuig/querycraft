import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "light";

interface SettingsState {
  theme: Theme;
  /** Лимит строк на результат. */
  maxRows: number;
  editorFontSize: number;
  setTheme: (theme: Theme) => void;
  setMaxRows: (n: number) => void;
  setEditorFontSize: (n: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      maxRows: 500,
      editorFontSize: 13,
      setTheme: (theme) => set({ theme }),
      setMaxRows: (maxRows) => set({ maxRows }),
      setEditorFontSize: (editorFontSize) => set({ editorFontSize }),
    }),
    { name: "querycraft-settings" },
  ),
);
