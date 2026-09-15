// Pure explorer tree model: builds a flat list of visible nodes
// from store state (no side effects — data loading is triggered by ExplorerPanel).
import type { ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, TableInfo } from "../../api/types";
import type { ConnectionStatus } from "../../store/connectionsStore";
import { dbKey, tableKey } from "../../store/explorerStore";

export type NodeKind =
  | "connection"
  | "database"
  | "group-tables"
  | "group-views"
  | "table"
  | "view"
  | "group-columns"
  | "column"
  | "group-indexes"
  | "index"
  | "group-fks"
  | "fk"
  | "loading"
  | "error"
  | "empty";

export interface TreeNode {
  key: string;
  kind: NodeKind;
  depth: number;
  connectionId: string;
  database?: string;
  table?: string;
  label: string;
  secondary?: string;
  title?: string;
  expandable: boolean;
  colorHex?: string | null;
  statusColor?: string;
  bold?: boolean;
  keyGlyph?: string;
}

export interface TreeModelInput {
  connections: ConnectionConfig[];
  runtimeStatus: Record<string, ConnectionStatus>;
  databases: Record<string, string[]>;
  tables: Record<string, TableInfo[]>;
  columns: Record<string, ColumnInfo[]>;
  indexes: Record<string, IndexInfo[]>;
  foreignKeys: Record<string, ForeignKeyInfo[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  expanded: Record<string, boolean>;
  filter: string;
}

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connected: "var(--success)",
  connecting: "var(--warning)",
  error: "var(--danger)",
  disconnected: "var(--fg-dim)",
};

export function fmtCount(n: number): string {
  return n.toLocaleString("ru-RU");
}

function matches(name: string, filter: string): boolean {
  return filter === "" || name.toLowerCase().includes(filter);
}

/** Child nodes for a "loading"/"error" node at a given depth. */
function statusChildren(depth: number, connectionId: string, database: string | undefined, key: string, isLoading: boolean, error: string | undefined): TreeNode[] {
  if (isLoading) {
    return [{ key: `${key}#loading`, kind: "loading", depth, connectionId, database, label: "Loading…", expandable: false }];
  }
  if (error) {
    return [{ key: `${key}#error`, kind: "error", depth, connectionId, database, label: error, expandable: false }];
  }
  return [];
}

export function buildTree(input: TreeModelInput): TreeNode[] {
  const filter = input.filter.trim().toLowerCase();
  const result: TreeNode[] = [];

  for (const conn of input.connections) {
    const status = input.runtimeStatus[conn.id] ?? "disconnected";
    const cKey = conn.id;
    result.push({
      key: cKey,
      kind: "connection",
      depth: 0,
      connectionId: conn.id,
      label: conn.name,
      secondary: status === "connected" ? conn.database ?? undefined : undefined,
      expandable: true,
      colorHex: conn.color,
      statusColor: STATUS_COLOR[status],
    });

    if (!input.expanded[cKey]) continue;

    if (status === "connecting") {
      result.push(...statusChildren(1, conn.id, undefined, cKey, true, undefined));
      continue;
    }
    if (status === "error") {
      result.push(...statusChildren(1, conn.id, undefined, cKey, false, input.errors[cKey] ?? "Connection error"));
      continue;
    }
    if (input.loading[cKey]) {
      result.push(...statusChildren(1, conn.id, undefined, cKey, true, undefined));
      continue;
    }
    if (input.errors[cKey]) {
      result.push(...statusChildren(1, conn.id, undefined, cKey, false, input.errors[cKey]));
      continue;
    }
    const dbs = input.databases[cKey];
    if (!dbs) continue;

    for (const db of dbs) {
      const dKey = dbKey(conn.id, db);
      const dbTables = input.tables[dKey];
      const dbMatches = matches(db, filter);
      const hasMatchingTable = filter !== "" && dbTables?.some((t) => matches(t.name, filter));
      if (filter !== "" && !dbMatches && !hasMatchingTable) continue;

      result.push({
        key: dKey,
        kind: "database",
        depth: 1,
        connectionId: conn.id,
        database: db,
        label: db,
        expandable: true,
        bold: db === conn.database,
      });

      if (!input.expanded[dKey]) continue;

      if (input.loading[dKey]) {
        result.push(...statusChildren(2, conn.id, db, dKey, true, undefined));
        continue;
      }
      if (input.errors[dKey]) {
        result.push(...statusChildren(2, conn.id, db, dKey, false, input.errors[dKey]));
        continue;
      }
      if (!dbTables) continue;

      const tableFilter = filter === "" || dbMatches ? "" : filter;
      pushTableGroup(result, conn.id, db, dKey, dbTables, "table", "group-tables", "Tables", tableFilter, input);
      pushTableGroup(result, conn.id, db, dKey, dbTables, "view", "group-views", "Views", tableFilter, input);
    }
  }

  return result;
}

function pushTableGroup(
  result: TreeNode[],
  connectionId: string,
  database: string,
  dKey: string,
  allTables: TableInfo[],
  wantKind: "table" | "view",
  groupKind: "group-tables" | "group-views",
  groupLabel: string,
  filter: string,
  input: TreeModelInput,
) {
  const items = allTables
    .filter((t) => t.kind === wantKind)
    .filter((t) => matches(t.name, filter))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (items.length === 0) return;

  const gKey = `${dKey}#${groupKind}`;
  result.push({
    key: gKey,
    kind: groupKind,
    depth: 2,
    connectionId,
    database,
    label: groupLabel,
    secondary: fmtCount(items.length),
    expandable: true,
  });
  if (!input.expanded[gKey]) return;

  for (const t of items) {
    const tKey = tableKey(connectionId, database, t.name);
    result.push({
      key: tKey,
      kind: wantKind,
      depth: 3,
      connectionId,
      database,
      table: t.name,
      label: t.name,
      secondary: t.rows != null ? fmtCount(t.rows) : undefined,
      title: t.comment || undefined,
      expandable: true,
    });
    if (!input.expanded[tKey]) continue;
    result.push(...tableChildren(connectionId, database, t.name, tKey, input));
  }
}

function tableChildren(connectionId: string, database: string, table: string, tKey: string, input: TreeModelInput): TreeNode[] {
  const out: TreeNode[] = [];
  if (input.loading[tKey]) return statusChildren(4, connectionId, database, tKey, true, undefined);
  if (input.errors[tKey]) return statusChildren(4, connectionId, database, tKey, false, input.errors[tKey]);

  const cols = input.columns[tKey];
  if (!cols) return out;

  for (const c of cols) {
    out.push({
      key: `${tKey}#columns/${c.name}`,
      kind: "column",
      depth: 4,
      connectionId,
      database,
      table,
      label: c.name,
      secondary: c.columnType,
      title: c.nullable ? undefined : "NOT NULL",
      expandable: false,
      keyGlyph: c.key === "PRI" ? "🔑" : c.key === "MUL" || c.key === "UNI" ? "◇" : undefined,
    });
  }

  const idxKey = `${tKey}#indexes`;
  out.push({
    key: idxKey,
    kind: "group-indexes",
    depth: 4,
    connectionId,
    database,
    table,
    label: "Indexes",
    expandable: true,
  });
  if (input.expanded[idxKey]) {
    if (input.loading[tKey]) out.push(...statusChildren(5, connectionId, database, idxKey, true, undefined));
    else {
      const idxs = input.indexes[tKey];
      for (const idx of idxs ?? []) {
        out.push({
          key: `${idxKey}/${idx.name}`,
          kind: "index",
          depth: 5,
          connectionId,
          database,
          table,
          label: idx.name,
          secondary: `${idx.unique ? "UNIQUE " : ""}(${idx.columns.join(", ")})`,
          expandable: false,
        });
      }
    }
  }

  const fks = input.foreignKeys[tKey];
  if (fks === undefined || fks.length > 0) {
    const fkKey = `${tKey}#fks`;
    out.push({
      key: fkKey,
      kind: "group-fks",
      depth: 4,
      connectionId,
      database,
      table,
      label: "Foreign keys",
      expandable: true,
    });
    if (input.expanded[fkKey]) {
      if (input.loading[tKey]) out.push(...statusChildren(5, connectionId, database, fkKey, true, undefined));
      else {
        for (const fk of fks ?? []) {
          out.push({
            key: `${fkKey}/${fk.name}`,
            kind: "fk",
            depth: 5,
            connectionId,
            database,
            table,
            label: fk.name,
            secondary: `→ ${fk.refDatabase}.${fk.refTable}`,
            expandable: false,
          });
        }
      }
    }
  }

  return out;
}
