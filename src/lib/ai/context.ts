// Turns schema metadata into compact, prompt-friendly text for the AI assistant. Pure functions
// only: no store or IPC access here (see `gather.ts` for the store-aware layer that loads the
// metadata and calls into this module).

import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableKind } from "../../api/types";

/** What `buildSchemaContext`/`renderTable` need to know about one table or view. */
export interface RenderableTable {
  name: string;
  kind: TableKind;
  comment?: string;
  /** Undefined when the columns have not been loaded yet (only the table list is known). */
  columns?: ColumnInfo[];
  foreignKeys?: ForeignKeyInfo[];
  /** Undefined when indexes have not been loaded (or were not requested — see `gatherSchemaContext`). */
  indexes?: IndexInfo[];
}

/** Default values that read fine unquoted in a DDL snippet; everything else is a string literal. */
const UNQUOTED_DEFAULT = /^(current_timestamp(\(\d*\))?|null|true|false|-?\d+(\.\d+)?)$/i;

function formatDefaultValue(value: string): string {
  return UNQUOTED_DEFAULT.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

function renderColumnDefinition(col: ColumnInfo): string {
  const parts = [col.name, col.columnType];
  if (!col.nullable) parts.push("NOT NULL");
  if (col.key === "PRI") parts.push("PRIMARY KEY");
  if (col.defaultValue !== null) parts.push(`DEFAULT ${formatDefaultValue(col.defaultValue)}`);
  if (col.extra) parts.push(col.extra);
  return parts.join(" ");
}

function renderForeignKeyDefinition(fk: ForeignKeyInfo): string {
  return `FOREIGN KEY (${fk.columns.join(", ")}) REFERENCES ${fk.refTable}(${fk.refColumns.join(", ")})`;
}

function renderIndexDefinition(index: IndexInfo): string {
  return `${index.unique ? "UNIQUE INDEX" : "INDEX"} ${index.name} (${index.columns.join(", ")})`;
}

/**
 * An index that is really just the primary key: named "PRIMARY" (MySQL's convention), or a unique
 * index whose column set is exactly the primary key's. Either way it adds nothing over the
 * `PRIMARY KEY` marker `renderColumnDefinition` already put on the column(s), so it is skipped.
 */
function isPrimaryKeyIndex(index: IndexInfo, pkColumns: string[]): boolean {
  if (index.name.toUpperCase() === "PRIMARY") return true;
  if (!index.unique || index.columns.length !== pkColumns.length) return false;
  const sortedIndex = [...index.columns].sort();
  const sortedPk = [...pkColumns].sort();
  return sortedIndex.every((col, i) => col === sortedPk[i]);
}

/**
 * Renders a table/view as a compact CREATE statement: just enough of the DDL for the model to
 * write correct SQL against it (types, nullability, keys, defaults, comments, foreign keys) without
 * the engine-specific noise (storage engine, charset, index definitions...).
 */
export function renderTable(table: RenderableTable): string {
  const createKeyword = table.kind === "view" ? "CREATE VIEW" : "CREATE TABLE";
  if (!table.columns) {
    return `${createKeyword} ${table.name} (...); -- columns not loaded`;
  }

  const lines: { code: string; comment?: string }[] = [...table.columns]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((col) => ({ code: renderColumnDefinition(col), comment: col.comment || undefined }));

  for (const fk of table.foreignKeys ?? []) {
    lines.push({ code: renderForeignKeyDefinition(fk) });
  }

  if (table.indexes?.length) {
    const pkColumns = [...table.columns]
      .filter((col) => col.key === "PRI")
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((col) => col.name);
    for (const index of table.indexes) {
      if (isPrimaryKeyIndex(index, pkColumns)) continue;
      lines.push({ code: renderIndexDefinition(index) });
    }
  }

  const body = lines
    .map((line, i) => {
      const comma = i === lines.length - 1 ? "" : ",";
      const comment = line.comment ? ` -- ${line.comment}` : "";
      return `  ${line.code}${comma}${comment}`;
    })
    .join("\n");

  const header = `${createKeyword} ${table.name} (${table.comment ? ` -- ${table.comment}` : ""}`;
  return `${header}\n${body}\n);`;
}

/** Extracts identifier-like tokens from free text, lowercased; a dotted token also yields its last part. */
function extractIdentifierTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_.]*/g;
  for (const match of text.matchAll(re)) {
    const token = match[0].toLowerCase();
    tokens.add(token);
    const lastDot = token.lastIndexOf(".");
    if (lastDot >= 0) tokens.add(token.slice(lastDot + 1));
  }
  return tokens;
}

/** The name forms a mention of `name` could plausibly appear as in free text: unqualified, and a
 * simple singular/plural variant (users/user, categories/category). */
function nameVariants(name: string): string[] {
  const lastDot = name.lastIndexOf(".");
  const base = (lastDot >= 0 ? name.slice(lastDot + 1) : name).toLowerCase();
  const variants = new Set([base]);
  if (base.endsWith("ies")) variants.add(`${base.slice(0, -3)}y`);
  else if (/[^aeiou]y$/.test(base)) variants.add(`${base.slice(0, -1)}ies`);
  if (base.endsWith("s")) variants.add(base.slice(0, -1));
  else variants.add(`${base}s`);
  return [...variants];
}

/**
 * Picks which tables to include in the schema context when there are too many to send them all:
 * tables the text seems to mention, plus their foreign-key neighbors, in the original order.
 * Everything else is left out (the caller lists the rest by name instead of rendering them).
 */
export function selectRelevantTables(
  names: string[],
  text: string,
  fkNeighbors: Record<string, string[]>,
  limit = 40,
): string[] {
  if (names.length <= limit) return [...names];

  const tokens = extractIdentifierTokens(text);
  const nameSet = new Set(names);
  const mentioned = names.filter((name) => nameVariants(name).some((v) => tokens.has(v)));

  const selected = new Set(mentioned);
  for (const name of mentioned) {
    for (const neighbor of fkNeighbors[name] ?? []) {
      if (nameSet.has(neighbor)) selected.add(neighbor);
    }
  }

  return names.filter((name) => selected.has(name)).slice(0, limit);
}

function renderOtherTablesNote(remaining: string[], budget: number): string {
  const prefix = "-- Other tables: ";
  for (let i = remaining.length; i >= 0; i--) {
    const dropped = remaining.length - i;
    const segments = remaining.slice(0, i);
    if (dropped > 0) segments.push(`...and ${dropped} more`);
    const candidate = prefix + segments.join(", ");
    if (candidate.length <= budget) return candidate;
  }
  return "";
}

/**
 * Builds the full schema context block for a prompt: renders the tables `selectRelevantTables`
 * picks (in a character budget), and appends a one-line note naming whatever else exists.
 */
export function buildSchemaContext(
  tables: RenderableTable[],
  text: string,
  { maxChars = 60000, limit = 40 }: { maxChars?: number; limit?: number } = {},
): string {
  const names = tables.map((t) => t.name);
  const fkNeighbors: Record<string, string[]> = {};
  for (const table of tables) {
    fkNeighbors[table.name] = (table.foreignKeys ?? []).map((fk) => fk.refTable);
  }

  const selected = selectRelevantTables(names, text, fkNeighbors, limit);
  const byName = new Map(tables.map((t) => [t.name, t] as const));

  const parts: string[] = [];
  const included = new Set<string>();
  let used = 0;
  for (const name of selected) {
    const table = byName.get(name);
    if (!table) continue;
    const rendered = renderTable(table);
    const addition = rendered.length + (parts.length > 0 ? 2 : 0); // 2 for the "\n\n" joiner
    if (used + addition > maxChars) break;
    parts.push(rendered);
    used += addition;
    included.add(name);
  }

  const remaining = names.filter((name) => !included.has(name));
  if (remaining.length > 0) {
    const joinerBudget = parts.length > 0 ? 2 : 0;
    const note = renderOtherTablesNote(remaining, maxChars - used - joinerBudget);
    if (note) parts.push(note);
  }

  return parts.join("\n\n");
}
