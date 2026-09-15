// Typed wrappers over Tauri invoke(). The only place where the frontend knows command names.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { mockInvoke } from "./mock";
import type {
  ApplyResult,
  ColumnInfo,
  ConnectionConfig,
  ConnectionInput,
  ExecuteRequest,
  ForeignKeyInfo,
  IndexInfo,
  ParamStatement,
  QueryHistoryEntry,
  ServerInfo,
  StatementResult,
  TableInfo,
} from "./types";

/** In a browser without Tauri (UI development), commands are served by the mock. */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const invoke: typeof tauriInvoke = isTauri
  ? tauriInvoke
  : (cmd, args) => mockInvoke(cmd, args as Record<string, unknown>);

// --- Connections -------------------------------------------------------------

export const listConnections = () => invoke<ConnectionConfig[]>("list_connections");

export const saveConnection = (input: ConnectionInput) => invoke<ConnectionConfig>("save_connection", { input });

export const deleteConnection = (id: string) => invoke<void>("delete_connection", { id });

/** Tests a connection without saving it. */
export const testConnection = (input: ConnectionInput) => invoke<ServerInfo>("test_connection", { input });

/** Opens a connection pool for the connection (required before any queries). */
export const connect = (connectionId: string) => invoke<ServerInfo>("connect", { connectionId });

/** Closes the pool and all sessions of the connection. */
export const disconnect = (connectionId: string) => invoke<void>("disconnect", { connectionId });

// --- Schema --------------------------------------------------------------

export const listDatabases = (connectionId: string) => invoke<string[]>("list_databases", { connectionId });

export const listTables = (connectionId: string, database: string) =>
  invoke<TableInfo[]>("list_tables", { connectionId, database });

export const listColumns = (connectionId: string, database: string, table: string) =>
  invoke<ColumnInfo[]>("list_columns", { connectionId, database, table });

export const listIndexes = (connectionId: string, database: string, table: string) =>
  invoke<IndexInfo[]>("list_indexes", { connectionId, database, table });

export const listForeignKeys = (connectionId: string, database: string, table: string) =>
  invoke<ForeignKeyInfo[]>("list_foreign_keys", { connectionId, database, table });

export const getTableDdl = (connectionId: string, database: string, table: string) =>
  invoke<string>("get_table_ddl", { connectionId, database, table });

// --- Execution -------------------------------------------------------------

/** Splits sql into statements and runs them sequentially in the session. */
export const executeQuery = (request: ExecuteRequest) => invoke<StatementResult[]>("execute_query", { request });

/** KILL QUERY for the query started with this queryId. */
export const cancelQuery = (connectionId: string, queryId: string) =>
  invoke<void>("cancel_query", { connectionId, queryId });

/** Runs parameterized statements in a single transaction (data editing). */
export const applyChanges = (connectionId: string, sessionId: string, statements: ParamStatement[]) =>
  invoke<ApplyResult>("apply_changes", { connectionId, sessionId, statements });

/** Closes the session connection (when a tab is closed). */
export const closeSession = (connectionId: string, sessionId: string) =>
  invoke<void>("close_session", { connectionId, sessionId });

// --- History ---------------------------------------------------------------

export const listHistory = (limit = 200) => invoke<QueryHistoryEntry[]>("list_history", { limit });

export const clearHistory = () => invoke<void>("clear_history");
