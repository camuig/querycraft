import { create } from "zustand";
import * as api from "../api/commands";
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, KeyListing, TableInfo } from "../api/types";

/** Keys shown per database node before they are truncated. */
const KEYS_LIMIT = 1000;

/** Schema metadata cache: keys are `${connectionId}`, `${connectionId}/${db}`, `${connectionId}/${db}/${table}`. */
interface ExplorerState {
  databases: Record<string, string[]>;
  tables: Record<string, TableInfo[]>;
  columns: Record<string, ColumnInfo[]>;
  indexes: Record<string, IndexInfo[]>;
  foreignKeys: Record<string, ForeignKeyInfo[]>;
  /** Redis/Valkey: keys of a database matching a MATCH pattern. Keyed by `keysKey(cid, db, pattern)`. */
  keys: Record<string, KeyListing>;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  /** Expanded tree nodes (node keys). */
  expanded: Record<string, boolean>;
  filter: string;

  /** Key of the selected tree node (see the key scheme in explorer/treeModel.ts). */
  selectedKey: string | null;
  /** Connection the selected node belongs to (or the node itself, if it is a connection). */
  selectedConnectionId: string | null;
  /** Database of the selected node (null for a connection node). */
  selectedDatabase: string | null;

  loadDatabases: (connectionId: string, force?: boolean) => Promise<string[]>;
  loadTables: (connectionId: string, db: string, force?: boolean) => Promise<TableInfo[]>;
  loadColumns: (connectionId: string, db: string, table: string, force?: boolean) => Promise<ColumnInfo[]>;
  loadIndexes: (connectionId: string, db: string, table: string, force?: boolean) => Promise<IndexInfo[]>;
  loadForeignKeys: (connectionId: string, db: string, table: string, force?: boolean) => Promise<ForeignKeyInfo[]>;
  loadKeys: (connectionId: string, db: string, pattern: string, force?: boolean) => Promise<KeyListing>;
  toggle: (key: string, value?: boolean) => void;
  setFilter: (filter: string) => void;
  invalidate: (prefix: string) => void;

  setSelectedConnectionId: (connectionId: string | null) => void;
  setSelectedDatabase: (database: string | null) => void;
  setSelectedKey: (key: string | null) => void;
  /** Atomically sets the selected tree node and the related connection/database. */
  selectNode: (key: string | null, connectionId: string | null, database: string | null) => void;
}

export const dbKey = (connectionId: string, db: string) => `${connectionId}/${db}`;
export const tableKey = (connectionId: string, db: string, table: string) => `${connectionId}/${db}/${table}`;
/** The pattern is part of the cache key: a different MATCH pattern is a different listing. */
export const keysKey = (connectionId: string, db: string, pattern: string) =>
  `${dbKey(connectionId, db)}#keys:${pattern}`;

export const useExplorerStore = create<ExplorerState>()((set, get) => {
  async function cached<T>(
    bucket: "databases" | "tables" | "columns" | "indexes" | "foreignKeys" | "keys",
    key: string,
    force: boolean,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const state = get();
    const existing = (state[bucket] as Record<string, T>)[key];
    if (existing && !force) return existing;
    set((s) => ({ loading: { ...s.loading, [key]: true }, errors: omit(s.errors, key) }));
    try {
      const data = await fetcher();
      set((s) => ({
        [bucket]: { ...(s[bucket] as Record<string, T>), [key]: data },
        loading: omit(s.loading, key),
      }));
      return data;
    } catch (e) {
      set((s) => ({ loading: omit(s.loading, key), errors: { ...s.errors, [key]: String(e) } }));
      throw e;
    }
  }

  return {
    databases: {},
    tables: {},
    columns: {},
    indexes: {},
    foreignKeys: {},
    keys: {},
    loading: {},
    errors: {},
    expanded: {},
    filter: "",
    selectedKey: null,
    selectedConnectionId: null,
    selectedDatabase: null,

    loadDatabases: (cid, force = false) => cached("databases", cid, force, () => api.listDatabases(cid)),
    loadTables: (cid, db, force = false) => cached("tables", dbKey(cid, db), force, () => api.listTables(cid, db)),
    loadColumns: (cid, db, t, force = false) =>
      cached("columns", tableKey(cid, db, t), force, () => api.listColumns(cid, db, t)),
    loadIndexes: (cid, db, t, force = false) =>
      cached("indexes", tableKey(cid, db, t), force, () => api.listIndexes(cid, db, t)),
    loadForeignKeys: (cid, db, t, force = false) =>
      cached("foreignKeys", tableKey(cid, db, t), force, () => api.listForeignKeys(cid, db, t)),
    loadKeys: (cid, db, pattern, force = false) =>
      cached("keys", keysKey(cid, db, pattern), force, () => api.listKeys(cid, db, pattern, KEYS_LIMIT)),

    toggle: (key, value) => set((s) => ({ expanded: { ...s.expanded, [key]: value ?? !s.expanded[key] } })),
    setFilter: (filter) => set({ filter }),

    setSelectedConnectionId: (connectionId) => set({ selectedConnectionId: connectionId }),
    setSelectedDatabase: (database) => set({ selectedDatabase: database }),
    setSelectedKey: (key) => set({ selectedKey: key }),
    selectNode: (key, connectionId, database) =>
      set({ selectedKey: key, selectedConnectionId: connectionId, selectedDatabase: database }),

    /** Clears the cache for all keys starting with prefix (e.g. on Refresh). */
    invalidate: (prefix) =>
      set((s) => ({
        databases: dropPrefix(s.databases, prefix),
        tables: dropPrefix(s.tables, prefix),
        columns: dropPrefix(s.columns, prefix),
        indexes: dropPrefix(s.indexes, prefix),
        foreignKeys: dropPrefix(s.foreignKeys, prefix),
        keys: dropPrefix(s.keys, prefix),
        errors: dropPrefix(s.errors, prefix),
      })),
  };
});

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

function dropPrefix<T>(obj: Record<string, T>, prefix: string): Record<string, T> {
  const copy: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) {
    // "/" separates a deeper cache key (tables, columns...); "#" separates a keys-bucket entry
    // (keysKey embeds the MATCH pattern after "#keys:") — both count as "under prefix".
    if (!(k === prefix || k.startsWith(`${prefix}/`) || k.startsWith(`${prefix}#`))) copy[k] = v;
  }
  return copy;
}
