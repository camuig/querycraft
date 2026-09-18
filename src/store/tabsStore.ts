import { create } from "zustand";
import * as api from "../api/commands";
import { newId } from "../lib/ids";

/** SQL console tab: its own database session (connection). */
export interface ConsoleTab {
  kind: "console";
  id: string;
  title: string;
  connectionId: string;
  database: string | null;
  /** sessionId == tab id — makes it simpler to close the session. */
  sessionId: string;
  sql: string;
}

/** Table data tab (viewing + editing). */
export interface TableDataTab {
  kind: "table";
  id: string;
  title: string;
  connectionId: string;
  database: string;
  table: string;
  sessionId: string;
}

/** Table DDL tab. */
export interface DdlTab {
  kind: "ddl";
  id: string;
  title: string;
  connectionId: string;
  database: string;
  table: string;
}

/** Redis/Valkey key data tab (viewing + editing one key's value) — the key-value counterpart of TableDataTab. */
export interface KeyDataTab {
  kind: "key";
  id: string;
  title: string;
  connectionId: string;
  database: string;
  key: string;
  /** Redis `TYPE` of the key at the time the tab was opened; drives which edit commands are offered. */
  keyType: string;
  sessionId: string;
}

export type Tab = ConsoleTab | TableDataTab | DdlTab | KeyDataTab;

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;

  openConsole: (connectionId: string, database: string | null, initialSql?: string) => string;
  openTableData: (connectionId: string, database: string, table: string) => string;
  openDdl: (connectionId: string, database: string, table: string) => string;
  openKeyData: (connectionId: string, database: string, key: string, keyType: string) => string;
  closeTab: (id: string) => void;
  closeTabsForConnection: (connectionId: string) => void;
  setActive: (id: string) => void;
  /** Activates the neighbouring tab (wraps around); `delta` is +1 or -1. Returns false when there is nothing to switch to. */
  activateSibling: (delta: 1 | -1) => boolean;
  updateConsole: (id: string, patch: Partial<Pick<ConsoleTab, "sql" | "database" | "title">>) => void;
}

let consoleCounter = 0;

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  openConsole: (connectionId, database, initialSql = "") => {
    const id = newId();
    consoleCounter += 1;
    const tab: ConsoleTab = {
      kind: "console",
      id,
      title: `console ${consoleCounter}`,
      connectionId,
      database,
      sessionId: id,
      sql: initialSql,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  openTableData: (connectionId, database, table) => {
    const existing = get().tabs.find(
      (t) => t.kind === "table" && t.connectionId === connectionId && t.database === database && t.table === table,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const id = newId();
    const tab: TableDataTab = { kind: "table", id, title: table, connectionId, database, table, sessionId: id };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  openDdl: (connectionId, database, table) => {
    const existing = get().tabs.find(
      (t) => t.kind === "ddl" && t.connectionId === connectionId && t.database === database && t.table === table,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const id = newId();
    const tab: DdlTab = { kind: "ddl", id, title: `${table} [DDL]`, connectionId, database, table };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  openKeyData: (connectionId, database, key, keyType) => {
    const existing = get().tabs.find(
      (t) => t.kind === "key" && t.connectionId === connectionId && t.database === database && t.key === key,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const id = newId();
    const tab: KeyDataTab = { kind: "key", id, title: key, connectionId, database, key, keyType, sessionId: id };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = tabs[idx];
    if (tab.kind === "console" || tab.kind === "table" || tab.kind === "key") {
      void api.closeSession(tab.connectionId, tab.sessionId).catch(() => undefined);
    }
    const next = tabs.filter((t) => t.id !== id);
    let nextActive = activeTabId;
    if (activeTabId === id) {
      nextActive = next[Math.min(idx, next.length - 1)]?.id ?? null;
    }
    set({ tabs: next, activeTabId: nextActive });
  },

  closeTabsForConnection: (connectionId) => {
    const { tabs, activeTabId } = get();
    const next = tabs.filter((t) => t.connectionId !== connectionId);
    const stillActive = next.some((t) => t.id === activeTabId);
    set({ tabs: next, activeTabId: stillActive ? activeTabId : (next[next.length - 1]?.id ?? null) });
  },

  setActive: (id) => set({ activeTabId: id }),

  activateSibling: (delta) => {
    const { tabs, activeTabId } = get();
    if (tabs.length < 2) return false;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = idx < 0 ? 0 : (idx + delta + tabs.length) % tabs.length;
    set({ activeTabId: tabs[next].id });
    return true;
  },

  updateConsole: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id && t.kind === "console" ? { ...t, ...patch } : t)),
    })),
}));
