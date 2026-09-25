// Typed wrappers over Tauri invoke(). The only place where the frontend knows command names.
import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { mockAiChat, mockInvoke } from "./mock";
import type {
  AiChatRequest,
  AiEndpoint,
  AiEvent,
  AiModel,
  ApplyResult,
  ColumnInfo,
  ConnectionConfig,
  ConnectionInput,
  CountRequest,
  ExecuteRequest,
  ExportRequest,
  ExportSummary,
  ForeignKeyInfo,
  IndexInfo,
  KeyListing,
  ParamStatement,
  QueryHistoryEntry,
  RowsExportRequest,
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

/** Keys of a key-value engine matching a glob pattern (`*` for all), at most `limit` of them. */
export const listKeys = (connectionId: string, database: string, pattern: string, limit: number) =>
  invoke<KeyListing>("list_keys", { connectionId, database, pattern, limit });

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

/** Writes the complete result of a statement (no row limit) to a file on the backend. */
export const exportQuery = (request: ExportRequest) => invoke<ExportSummary>("export_query", { request });

/** Writes the given rows (the grid contents) to a file on the backend. */
export const exportRows = (request: RowsExportRequest) => invoke<ExportSummary>("export_rows", { request });

/** Counts the rows a statement produces (SELECT COUNT(*) over it). */
export const countQuery = (request: CountRequest) => invoke<number>("count_query", { request });

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

// --- AI assistant ------------------------------------------------------------

/** Which of the given provider ids have a saved API key in the backend's SecretStore. */
export const aiKeyStatus = (providerIds: string[]) => invoke<Record<string, boolean>>("ai_key_status", { providerIds });

/** Saves an API key for a provider; an empty string deletes it. */
export const aiSetKey = (providerId: string, apiKey: string) => invoke<void>("ai_set_key", { providerId, apiKey });

export const aiDeleteKey = (providerId: string) => invoke<void>("ai_delete_key", { providerId });

/** Lists a provider's models; also doubles as "verify this API key" for the Settings dialog. */
export const aiListModels = (endpoint: AiEndpoint) => invoke<AiModel[]>("ai_list_models", { endpoint });

/**
 * Streams a chat completion, calling `onEvent` for every delta/done event and resolving with the
 * full response text once the model finishes (or rejecting, e.g. with "Cancelled" after `aiCancel`).
 * In the browser mock (no Tauri runtime) a fake streamer is used instead of `Channel`, which needs
 * the real Tauri IPC internals and cannot be constructed outside a Tauri webview.
 */
export const aiChat = (request: AiChatRequest, onEvent: (event: AiEvent) => void): Promise<string> => {
  if (!isTauri) return mockAiChat(request, onEvent);
  const channel = new Channel<AiEvent>();
  channel.onmessage = onEvent;
  return tauriInvoke<string>("ai_chat", { request, onEvent: channel });
};

/** Aborts a running `aiChat` by its requestId; no error if it is already finished or unknown. */
export const aiCancel = (requestId: string) => invoke<void>("ai_cancel", { requestId });
