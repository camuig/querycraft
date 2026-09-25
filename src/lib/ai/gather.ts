// Store-aware layer that feeds the explorer store's cached schema metadata into `context.ts`'s
// pure schema-context builder. Kept separate from context.ts so that module stays pure and easy to
// unit-test without a store.

import type { DbKind, ForeignKeyInfo, TableInfo } from "../../api/types";
import { selectConnectionKind, useConnectionsStore } from "../../store/connectionsStore";
import { useExplorerStore } from "../../store/explorerStore";
import { buildSchemaContext, type RenderableTable, selectRelevantTables } from "./context";

const SCHEMA_CONTEXT_LIMIT = 40;

/** Key-value engines have no relational schema to share in the MVP. */
const NO_SCHEMA_KINDS: DbKind[] = ["redis", "valkey"];

/**
 * Gathers a compact schema context for the AI assistant: the connection's table list, plus just
 * enough columns and foreign keys to describe the tables `text` is likely about (see
 * `selectRelevantTables` — tables the text mentions, and their foreign-key neighbors). Only the
 * selected tables' columns/foreign keys are loaded, to keep this fast on large schemas.
 *
 * Per-table load failures are swallowed: a table whose foreign keys failed to load simply
 * contributes no FK neighbors and no FK lines, and one whose columns failed to load renders as
 * "columns not loaded" instead of failing the whole request.
 */
export async function gatherSchemaContext(connectionId: string, database: string, text: string): Promise<string> {
  const kind = selectConnectionKind(connectionId)(useConnectionsStore.getState());
  if (NO_SCHEMA_KINDS.includes(kind)) return "";

  const explorer = useExplorerStore.getState();
  let tables: TableInfo[];
  try {
    tables = await explorer.loadTables(connectionId, database);
  } catch {
    return "";
  }
  if (tables.length === 0) return "";

  const names = tables.map((t) => t.name);

  // First pass: which tables the text seems to be about, ignoring FK neighbors (not loaded yet).
  const mentioned = selectRelevantTables(names, text, {}, SCHEMA_CONTEXT_LIMIT);

  const foreignKeysByTable = new Map<string, ForeignKeyInfo[]>();
  await Promise.all(
    mentioned.map(async (name) => {
      try {
        foreignKeysByTable.set(name, await explorer.loadForeignKeys(connectionId, database, name));
      } catch {
        // No FK info for this table: it contributes no neighbors and no FK lines below.
      }
    }),
  );

  const fkNeighbors: Record<string, string[]> = {};
  for (const [name, foreignKeys] of foreignKeysByTable) {
    fkNeighbors[name] = foreignKeys.map((fk) => fk.refTable);
  }

  // Second pass: the same selection, now expanded with the FK neighbors of the mentioned tables.
  const expanded = selectRelevantTables(names, text, fkNeighbors, SCHEMA_CONTEXT_LIMIT);

  const columnsByTable = new Map<string, RenderableTable["columns"]>();
  await Promise.all(
    expanded.map(async (name) => {
      try {
        columnsByTable.set(name, await explorer.loadColumns(connectionId, database, name));
      } catch {
        // Left undefined: renderTable falls back to a "columns not loaded" placeholder.
      }
    }),
  );

  // buildSchemaContext re-derives the same selection from `text` and each table's own
  // (possibly absent) foreignKeys, so it renders exactly the tables loaded above and lists the
  // rest by name only.
  const renderable: RenderableTable[] = tables.map((table) => ({
    name: table.name,
    kind: table.kind,
    comment: table.comment,
    columns: columnsByTable.get(table.name),
    foreignKeys: foreignKeysByTable.get(table.name),
  }));

  return buildSchemaContext(renderable, text, { limit: SCHEMA_CONTEXT_LIMIT });
}
