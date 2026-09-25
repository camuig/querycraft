// Contract between the frontend and the Rust backend. Mirrors the structs in src-tauri/src.
// All fields are camelCase (serde rename_all = "camelCase" on the Rust side).

/** Supported database engines (serialized in lowercase, see `DbKind` in src-tauri/src/db/mod.rs). */
export type DbKind = "mysql" | "mariadb" | "postgres" | "clickhouse" | "sqlite" | "redis" | "valkey" | "mssql";

/** What a console sends to the engine: SQL statements or key-value commands (one per line, redis-cli syntax). */
export type QueryLanguage = "sql" | "redis";

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

/** Wire protocol spoken by an AI provider (see `src/lib/ai/providers.ts` for the presets built on top of it). */
export type AiProtocol = "anthropic" | "openai";

/** What a connection may share with the AI assistant: schema + query, query only, or nothing. */
export type AiAccess = "schema" | "query" | "off";

/** Where and how to reach an AI provider. `apiKey` is only set when verifying an unsaved key; otherwise the
 * backend loads the saved key (if any) from the SecretStore under `ai/<providerId>`. */
export interface AiEndpoint {
  providerId: string;
  protocol: AiProtocol;
  baseUrl: string;
  apiKey: string | null;
}

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiChatRequest {
  requestId: string;
  endpoint: AiEndpoint;
  model: string;
  system: string;
  messages: AiMessage[];
  /** Defaults to 16000 on the backend when omitted. */
  maxTokens: number | null;
}

/** A model reported by `ai_list_models`. `name` is the provider's display name, when it has one. */
export interface AiModel {
  id: string;
  name: string | null;
}

/** Streamed over the `ai_chat` channel. */
export type AiEvent = { kind: "delta"; text: string } | { kind: "done"; stopReason: string | null };

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
  /** How much this connection may share with the AI assistant. */
  aiAccess: AiAccess;
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
  /** How much this connection may share with the AI assistant. */
  aiAccess: AiAccess;
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

/** One key of a key-value engine (Redis, Valkey) — the explorer's counterpart of `TableInfo`. */
export interface KeyInfo {
  name: string;
  /** Redis `TYPE` reply: "string" | "hash" | "list" | "set" | "zset" | "stream" | ... */
  keyType: string;
  /** Number of elements (hash fields, list items, set members, stream entries) or the string length. */
  length: number | null;
  /** Seconds until expiry; null when the key does not expire. */
  ttl: number | null;
}

export interface KeyListing {
  keys: KeyInfo[];
  /** More keys match the pattern than the requested limit. */
  truncated: boolean;
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

export type ExportFormat = "csv" | "json" | "xlsx";

/** Writes rows the frontend already holds (the grid contents) to a file. */
export interface RowsExportRequest {
  columns: ColumnMeta[];
  rows: CellValue[][];
  format: ExportFormat;
  path: string;
}

/** SELECT COUNT(*) over one statement: the total behind a result truncated by the row limit. */
export interface CountRequest {
  connectionId: string;
  sessionId: string;
  queryId: string;
  sql: string;
  database: string | null;
}

/** Re-runs one statement without the row limit and writes its result set to a file. */
export interface ExportRequest {
  connectionId: string;
  sessionId: string;
  queryId: string;
  /** A single statement: the `sql` of the result being exported. */
  sql: string;
  database: string | null;
  format: ExportFormat;
  path: string;
}

export interface ExportSummary {
  rows: number;
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
