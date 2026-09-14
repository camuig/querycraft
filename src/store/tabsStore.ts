import { create } from "zustand";
import { newId } from "../lib/ids";
import * as api from "../api/commands";

/** Вкладка SQL-консоли: своя сессия (соединение) MySQL. */
export interface ConsoleTab {
  kind: "console";
  id: string;
  title: string;
  connectionId: string;
  database: string | null;
  /** sessionId == id вкладки — так проще закрывать сессию. */
  sessionId: string;
  sql: string;
}

/** Вкладка данных таблицы (просмотр + редактирование). */
export interface TableDataTab {
  kind: "table";
  id: string;
  title: string;
  connectionId: string;
  database: string;
  table: string;
  sessionId: string;
}

/** Вкладка DDL таблицы. */
export interface DdlTab {
  kind: "ddl";
  id: string;
  title: string;
  connectionId: string;
  database: string;
  table: string;
}

export type Tab = ConsoleTab | TableDataTab | DdlTab;

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;

  openConsole: (connectionId: string, database: string | null, initialSql?: string) => string;
  openTableData: (connectionId: string, database: string, table: string) => string;
  openDdl: (connectionId: string, database: string, table: string) => string;
  closeTab: (id: string) => void;
  closeTabsForConnection: (connectionId: string) => void;
  setActive: (id: string) => void;
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

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = tabs[idx];
    if (tab.kind === "console" || tab.kind === "table") {
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

  updateConsole: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id && t.kind === "console" ? { ...t, ...patch } : t)),
    })),
}));
