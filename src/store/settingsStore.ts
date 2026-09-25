import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The theme actually applied. */
export type ResolvedTheme = "dark" | "light";
/** User preference: "system" means follow the OS setting. */
export type ThemePreference = ResolvedTheme | "system";

export const MAX_ROWS_OPTIONS = [100, 500, 1000, 5000];
export const MIN_EDITOR_FONT_SIZE = 10;
export const MAX_EDITOR_FONT_SIZE = 24;

/** Tab of the settings dialog. */
export type SettingsTab = "general" | "ai";

interface SettingsState {
  theme: ThemePreference;
  /** Whether the system theme is dark (updated via matchMedia in App). Not persisted. */
  systemDark: boolean;
  /** Row limit per result. */
  maxRows: number;
  editorFontSize: number;
  /** Check for a new version at startup and install it automatically. */
  autoUpdate: boolean;
  /** Whether the settings dialog is open. Not persisted. */
  dialogOpen: boolean;
  /** Tab the settings dialog should show. Not persisted. */
  dialogTab: SettingsTab;
  /** Chosen AI provider id (see `src/lib/ai/providers.ts`); null until the user picks one. */
  aiProviderId: string | null;
  /** Chosen model per provider id, so switching providers and back remembers the pick. */
  aiModels: Record<string, string>;
  /** Base URL override per provider id (local runtimes, and the custom OpenAI-compatible preset). */
  aiBaseUrls: Record<string, string>;
  setTheme: (theme: ThemePreference) => void;
  setSystemDark: (dark: boolean) => void;
  setMaxRows: (n: number) => void;
  setEditorFontSize: (n: number) => void;
  setAutoUpdate: (on: boolean) => void;
  /** Opens the settings dialog, optionally on a specific tab (defaults to "general"). */
  openDialog: (tab?: SettingsTab) => void;
  closeDialog: () => void;
  setAiProvider: (providerId: string | null) => void;
  setAiModel: (providerId: string, model: string) => void;
  setAiBaseUrl: (providerId: string, url: string) => void;
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
      autoUpdate: true,
      dialogOpen: false,
      dialogTab: "general",
      aiProviderId: null,
      aiModels: {},
      aiBaseUrls: {},
      setTheme: (theme) => set({ theme }),
      setSystemDark: (systemDark) => set({ systemDark }),
      setMaxRows: (maxRows) => set({ maxRows }),
      setEditorFontSize: (editorFontSize) =>
        set({
          editorFontSize: Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Math.round(editorFontSize))),
        }),
      setAutoUpdate: (autoUpdate) => set({ autoUpdate }),
      openDialog: (tab) => set({ dialogOpen: true, dialogTab: tab ?? "general" }),
      closeDialog: () => set({ dialogOpen: false }),
      setAiProvider: (aiProviderId) => set({ aiProviderId }),
      setAiModel: (providerId, model) => set((s) => ({ aiModels: { ...s.aiModels, [providerId]: model } })),
      setAiBaseUrl: (providerId, url) => set((s) => ({ aiBaseUrls: { ...s.aiBaseUrls, [providerId]: url } })),
    }),
    {
      name: "querycraft-settings",
      partialize: (s) => ({
        theme: s.theme,
        maxRows: s.maxRows,
        editorFontSize: s.editorFontSize,
        autoUpdate: s.autoUpdate,
        aiProviderId: s.aiProviderId,
        aiModels: s.aiModels,
        aiBaseUrls: s.aiBaseUrls,
      }),
    },
  ),
);

/** Selector for the resolved theme, accounting for "system" mode. */
export const selectResolvedTheme = (s: Pick<SettingsState, "theme" | "systemDark">): ResolvedTheme =>
  s.theme === "system" ? (s.systemDark ? "dark" : "light") : s.theme;
