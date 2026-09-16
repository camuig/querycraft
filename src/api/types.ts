// Contract between the frontend and the Rust backend. Mirrors the structs in src-tauri/src.
// All fields are camelCase (serde rename_all = "camelCase" on the Rust side).

/** Supported database engines (serialized in lowercase, see `DbKind` in src-tauri/src/db/mod.rs). */
export type DbKind = "mysql" | "mariadb" | "postgres" | "clickhouse" | "sqlite";

/** How the SSH tunnel authenticates: a password, a private key file (optionally with a passphrase) or the running OpenSSH agent. */
export type SshAuth = "password" | "key" | "agent";

/** SSH tunnel settings (DataGrip's "SSH/SSL" tab): the database is reached through a port forwarded over this host. */
export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  /** Private key file for `auth === "key"`. */
  keyPath: string | null;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  /** Default database (can be empty). */
  database: string | null;
  ssl: boolean;
  /** Verify the server certificate when SSL is on. */
  sslVerify: boolean;
  /** PEM file with the CA certificate(s) that sign the server certificate; null uses the system trust store only. */
  sslCaPath: string | null;
  /** Connection tag color (hex) — like DataGrip's prod/dev coloring. */
  color: string | null;
  /** Database file for file-based engines (SQLite); host/port/user are unused then. */
  path: string | null;
  /** SSH tunnel; null connects directly. */
  ssh: SshConfig | null;
  /** Whether a password is saved in the keyring. */
  hasPassword: boolean;
  /** Whether the SSH password / key passphrase is saved in the keyring. */
  hasSshSecret: boolean;
}

/** What the frontend sends when saving/testing a connection. */
export interface ConnectionInput {
  id: string | null;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  password: string | null;
  savePassword: boolean;
  database: string | null;
  ssl: boolean;
  sslVerify: boolean;
  sslCaPath: string | null;
  color: string | null;
  path: string | null;
  ssh: SshConfig | null;
  /** SSH password (auth "password") or key passphrase (auth "key"); stored under the same "save password" policy. */
  sshSecret: string | null;
}

export interface ServerInfo {
  serverVersion: string;
  /** Backend-side session id (MySQL CONNECTION_ID(), PostgreSQL pg_backend_pid()), when the engine has one. */
  connectionId: number | null;
}

export type TableKind = "table" | "view";

export interface TableInfo {
  name: string;
  kind: TableKind;
  /** Storage engine (MySQL, ClickHouse) when the catalog reports one. */
  engine: string | null;
  /** Approximate row count from the catalog, when available. */
  rows: number | null;
  comment: string;
}

export interface ColumnInfo {
  name: string;
  /** E.g. "int", "varchar". */
  dataType: string;
  /** Full type, e.g. "varchar(255)", "int unsigned", "Nullable(String)". */
  columnType: string;
  nullable: boolean;
  /** "PRI" | "UNI" | "MUL" | "" — MySQL vocabulary; other engines map onto it ("PRI" marks primary key columns). */
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
  /** Uppercase engine type name: "VARCHAR", "INT", "DATETIME", "DECIMAL", "BLOB", "JSON"... */
  typeName: string;
  /** MySQL only; always false for other engines. */
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
  /** Session (tab) identifier — its own database connection. Created lazily. */
  sessionId: string;
  /** Query identifier, used for cancellation. */
  queryId: string;
  sql: string;
  /** Row limit per result (defaults to 500). */
  maxRows: number;
  /** If set, a new session is positioned on it (USE / search_path / HTTP database parameter). */
  database: string | null;
  /** Stop execution on the first error. */
  stopOnError: boolean;
}

/** A statement with positional `?` placeholders; the backend rewrites them for engines with other syntax. */
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
