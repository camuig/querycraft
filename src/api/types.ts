// Contract between the frontend and the Rust backend. Mirrors the structs in src-tauri/src.
// All fields are camelCase (serde rename_all = "camelCase" on the Rust side).

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** Default database (can be empty). */
  database: string | null;
  ssl: boolean;
  /** Connection tag color (hex) — like DataGrip's prod/dev coloring. */
  color: string | null;
  /** Whether a password is saved in the keyring. */
  hasPassword: boolean;
}

/** What the frontend sends when saving/testing a connection. */
export interface ConnectionInput {
  id: string | null;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string | null;
  savePassword: boolean;
  database: string | null;
  ssl: boolean;
  color: string | null;
}

export interface ServerInfo {
  serverVersion: string;
  /** Session's CONNECTION_ID() (for debugging). */
  connectionId: number;
}

export type TableKind = "table" | "view";

export interface TableInfo {
  name: string;
  kind: TableKind;
  engine: string | null;
  /** Approximate row count from information_schema. */
  rows: number | null;
  comment: string;
}

export interface ColumnInfo {
  name: string;
  /** E.g. "int", "varchar". */
  dataType: string;
  /** Full type, e.g. "varchar(255)", "int unsigned". */
  columnType: string;
  nullable: boolean;
  /** "PRI" | "UNI" | "MUL" | "" */
  key: string;
  defaultValue: string | null;
  /** auto_increment, on update ... */
  extra: string;
  comment: string;
  /** Ordinal position, starting at 1. */
  ordinal: number;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
  indexType: string;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refDatabase: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

/**
 * Cell value in JSON:
 *  - null — SQL NULL
 *  - number — integers within the safe integer range, float/double
 *  - string — everything else (text, decimal, large integers, dates as "YYYY-MM-DD HH:MM:SS", binary as "0x...")
 *  - boolean — not used by the backend, but allowed while editing
 */
export type CellValue = null | number | string | boolean;

export interface ColumnMeta {
  name: string;
  /** Source table (if known). */
  table: string | null;
  database: string | null;
  /** Uppercase MySQL type name: "VARCHAR", "INT", "DATETIME", "DECIMAL", "BLOB", "JSON"... */
  typeName: string;
  unsigned: boolean;
  nullable: boolean;
  primaryKey: boolean;
  /** Binary data (BLOB/BINARY) — editing not supported in the MVP. */
  binary: boolean;
}

export type StatementResultKind = "rows" | "affected" | "error";

export interface StatementResult {
  /** Text of the executed statement. */
  sql: string;
  kind: StatementResultKind;
  columns: ColumnMeta[];
  rows: CellValue[][];
  /** true if rows were truncated by the maxRows limit. */
  truncated: boolean;
  affectedRows: number;
  lastInsertId: number | null;
  error: string | null;
  durationMs: number;
}

export interface ExecuteRequest {
  connectionId: string;
  /** Session (tab) identifier — its own MySQL connection. Created lazily. */
  sessionId: string;
  /** Query identifier, used for cancellation. */
  queryId: string;
  sql: string;
  /** Row limit per result (defaults to 500). */
  maxRows: number;
  /** If set, run USE before the query (for a new session). */
  database: string | null;
  /** Stop execution on the first error. */
  stopOnError: boolean;
}

export interface ParamStatement {
  sql: string;
  params: CellValue[];
}

export interface ApplyResult {
  affectedRows: number;
  durationMs: number;
}

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  database: string | null;
  sql: string;
  /** ISO 8601 */
  executedAt: string;
  durationMs: number;
  success: boolean;
}
