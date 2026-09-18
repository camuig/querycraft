// Pure logic for the key data tab (the Redis/Valkey counterpart of TableDataTab): what command
// loads a key's full value, which edits are possible per `TYPE`, and how grid edits turn into
// the parameterized commands `api.applyChanges` runs atomically (MULTI/EXEC on the backend).

import type { CellValue, ColumnMeta, ParamStatement } from "../api/types";
import type { ChangeTracker } from "./changeTracker";
import { quoteRedisKey } from "./redisCommands";

export interface KeyEditCapabilities {
  /** Existing cells (and hash field / set member / zset member renames) can be edited. */
  cellEdit: boolean;
  /** Rows can be appended (Add row). */
  canInsert: boolean;
  /** Rows can be marked for deletion (Delete row). */
  canDelete: boolean;
}

const CAPABILITIES: Record<string, KeyEditCapabilities> = {
  string: { cellEdit: true, canInsert: false, canDelete: false },
  hash: { cellEdit: true, canInsert: true, canDelete: true },
  list: { cellEdit: true, canInsert: true, canDelete: true },
  set: { cellEdit: true, canInsert: true, canDelete: true },
  zset: { cellEdit: true, canInsert: true, canDelete: true },
  stream: { cellEdit: false, canInsert: false, canDelete: true },
};

/** What the key data tab's toolbar may offer for a given `TYPE`; unknown types are fully read-only. */
export function keyEditCapabilities(keyType: string): KeyEditCapabilities {
  return CAPABILITIES[keyType] ?? { cellEdit: false, canInsert: false, canDelete: false };
}

/**
 * Command that loads a key's FULL value for editing (unlike `keyPreviewCommand`, which caps
 * streams at 100 entries for a quick look from the explorer).
 */
export function keyLoadCommand(key: string, keyType: string): string {
  const q = quoteRedisKey(key);
  switch (keyType) {
    case "string":
      return `GET ${q}`;
    case "hash":
      return `HGETALL ${q}`;
    case "list":
      return `LRANGE ${q} 0 -1`;
    case "set":
      return `SMEMBERS ${q}`;
    case "zset":
      return `ZRANGE ${q} 0 -1 WITHSCORES`;
    case "stream":
      return `XRANGE ${q} - + COUNT 500`;
    default:
      return `TYPE ${q}`;
  }
}

const INDEX_COLUMN: ColumnMeta = {
  name: "index",
  table: null,
  database: null,
  typeName: "INT",
  unsigned: false,
  nullable: false,
  primaryKey: false,
  // Repurposed as "not editable" rather than actual binary data: DataGrid already skips binary
  // columns for inline edit, Set NULL and paste, which is exactly what a synthetic, display-only
  // index column needs — LSET/LREM always target the row's POSITION, never this cell's value.
  binary: true,
};

/** Prepends a synthetic, read-only 0-based `index` column to a list's LRANGE result. */
export function withListIndexColumn(
  columns: ColumnMeta[],
  rows: CellValue[][],
): { columns: ColumnMeta[]; rows: CellValue[][] } {
  return {
    columns: [INDEX_COLUMN, ...columns],
    rows: rows.map((row, i) => [i, ...row]),
  };
}

export type BuildKeyStatementsResult = { ok: true; statements: ParamStatement[] } | { ok: false; error: string };

function isBlank(v: CellValue): boolean {
  return v === null || (typeof v === "string" && v.trim() === "");
}

/** A cell value required to be present (used as a field/member/element/value argument). */
function requireCell(v: CellValue, message: string): CellValue {
  if (isBlank(v)) throw new Error(message);
  return v;
}

/** Parses a score cell into a finite number, accepting both a number and a numeric string. */
function parseScore(v: CellValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface ClassifiedRows {
  deletes: number[];
  updates: number[];
  inserts: number[];
}

/** Same classification as `ChangeTracker`'s private one — deleted-and-inserted rows cancel out. */
function classifyRows(tracker: ChangeTracker, columnCount: number): ClassifiedRows {
  const deletes: number[] = [];
  const updates: number[] = [];
  const inserts: number[] = [];
  const rowCount = tracker.rows.length;

  for (let r = 0; r < rowCount; r++) {
    const deleted = tracker.isDeleted(r);
    const inserted = tracker.isInserted(r);
    if (deleted && inserted) continue;
    if (deleted) {
      deletes.push(r);
      continue;
    }
    if (inserted) {
      inserts.push(r);
      continue;
    }
    let modified = false;
    for (let c = 0; c < columnCount; c++) {
      if (tracker.isModified(r, c)) {
        modified = true;
        break;
      }
    }
    if (modified) updates.push(r);
  }

  return { deletes, updates, inserts };
}

function buildStringStatements(out: ParamStatement[], key: string, updates: number[], tracker: ChangeTracker) {
  for (const r of updates) {
    const value = requireCell(tracker.getValue(r, 0), "Value is required");
    out.push({ sql: "SET", params: [key, value, "KEEPTTL"] });
  }
}

function buildHashStatements(
  out: ParamStatement[],
  key: string,
  rows: ClassifiedRows,
  originalRows: CellValue[][],
  tracker: ChangeTracker,
) {
  for (const r of rows.deletes) {
    const field = originalRows[r]?.[0] ?? null;
    if (field !== null) out.push({ sql: "HDEL", params: [key, field] });
  }
  for (const r of rows.updates) {
    const origField = originalRows[r]?.[0] ?? null;
    const field = requireCell(tracker.getValue(r, 0), "Field and value are required");
    const value = requireCell(tracker.getValue(r, 1), "Field and value are required");
    if (origField !== null && origField !== field) out.push({ sql: "HDEL", params: [key, origField] });
    out.push({ sql: "HSET", params: [key, field, value] });
  }
  for (const r of rows.inserts) {
    const field = requireCell(tracker.getValue(r, 0), "Field and value are required");
    const value = requireCell(tracker.getValue(r, 1), "Field and value are required");
    out.push({ sql: "HSET", params: [key, field, value] });
  }
}

/**
 * `LREM` shifts the position of every element after the ones it removes, so every `LSET` that
 * targets an original row position — real edits as well as the delete sentinels — must run
 * first; the single `LREM` that turns the sentinels into an actual removal comes last, and only
 * then is it safe to `RPUSH` (append order is position-independent, so it can go either side of
 * the removal, but doing it last keeps the statement list easy to read top to bottom).
 */
function buildListStatements(out: ParamStatement[], key: string, rows: ClassifiedRows, tracker: ChangeTracker) {
  for (const r of rows.updates) {
    const element = requireCell(tracker.getValue(r, 1), "Element value is required");
    out.push({ sql: "LSET", params: [key, r, element] });
  }
  if (rows.deletes.length > 0) {
    const sentinel = `__querycraft_deleted__${Math.random().toString(36).slice(2)}`;
    for (const r of rows.deletes) {
      out.push({ sql: "LSET", params: [key, r, sentinel] });
    }
    out.push({ sql: "LREM", params: [key, 0, sentinel] });
  }
  for (const r of rows.inserts) {
    const element = requireCell(tracker.getValue(r, 1), "Element value is required");
    out.push({ sql: "RPUSH", params: [key, element] });
  }
}

function buildSetStatements(
  out: ParamStatement[],
  key: string,
  rows: ClassifiedRows,
  originalRows: CellValue[][],
  tracker: ChangeTracker,
) {
  for (const r of rows.deletes) {
    const member = originalRows[r]?.[0] ?? null;
    if (member !== null) out.push({ sql: "SREM", params: [key, member] });
  }
  for (const r of rows.updates) {
    const origMember = originalRows[r]?.[0] ?? null;
    const member = requireCell(tracker.getValue(r, 0), "Member is required");
    if (origMember !== null && origMember !== member) out.push({ sql: "SREM", params: [key, origMember] });
    out.push({ sql: "SADD", params: [key, member] });
  }
  for (const r of rows.inserts) {
    const member = requireCell(tracker.getValue(r, 0), "Member is required");
    out.push({ sql: "SADD", params: [key, member] });
  }
}

function buildZsetStatements(
  out: ParamStatement[],
  key: string,
  rows: ClassifiedRows,
  originalRows: CellValue[][],
  tracker: ChangeTracker,
) {
  for (const r of rows.deletes) {
    const member = originalRows[r]?.[0] ?? null;
    if (member !== null) out.push({ sql: "ZREM", params: [key, member] });
  }
  for (const r of rows.updates) {
    const origMember = originalRows[r]?.[0] ?? null;
    const member = requireCell(tracker.getValue(r, 0), "Member is required");
    const score = parseScore(tracker.getValue(r, 1));
    if (score === null) throw new Error("Score must be a number");
    if (origMember !== null && origMember !== member) out.push({ sql: "ZREM", params: [key, origMember] });
    out.push({ sql: "ZADD", params: [key, score, member] });
  }
  for (const r of rows.inserts) {
    const member = requireCell(tracker.getValue(r, 0), "Member is required");
    const score = parseScore(tracker.getValue(r, 1));
    if (score === null) throw new Error("Score must be a number");
    out.push({ sql: "ZADD", params: [key, score, member] });
  }
}

function buildStreamStatements(out: ParamStatement[], key: string, deletes: number[], originalRows: CellValue[][]) {
  for (const r of deletes) {
    const id = originalRows[r]?.[0] ?? null;
    if (id !== null) out.push({ sql: "XDEL", params: [key, id] });
  }
}

/**
 * Builds the parameterized commands for one Submit of the key data grid, always led by a
 * `SELECT <db>` so the batch targets the right database even if the session was recreated.
 *
 * `originalRows`/`columns` are the rows/columns the grid was loaded with (before any edits);
 * `tracker` holds the current edit state. Row/column indices are POSITIONAL and their meaning
 * depends on `keyType` (field/value for hash, index/element for list, member for set,
 * member/score for zset, id/... for stream) — `columns` only tells us how many columns a row
 * has, never their names, since they come straight from the backend's result set (the `index`
 * column of a list is the one exception: it is added on the frontend, see `withListIndexColumn`).
 */
export function buildKeyStatements(
  database: string,
  key: string,
  keyType: string,
  originalRows: CellValue[][],
  tracker: ChangeTracker,
  columns: ColumnMeta[],
): BuildKeyStatementsResult {
  const statements: ParamStatement[] = [{ sql: "SELECT", params: [database] }];
  const rows = classifyRows(tracker, columns.length);

  try {
    switch (keyType) {
      case "string":
        buildStringStatements(statements, key, rows.updates, tracker);
        break;
      case "hash":
        buildHashStatements(statements, key, rows, originalRows, tracker);
        break;
      case "list":
        buildListStatements(statements, key, rows, tracker);
        break;
      case "set":
        buildSetStatements(statements, key, rows, originalRows, tracker);
        break;
      case "zset":
        buildZsetStatements(statements, key, rows, originalRows, tracker);
        break;
      case "stream":
        buildStreamStatements(statements, key, rows.deletes, originalRows);
        break;
      default:
        break;
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return { ok: true, statements };
}
