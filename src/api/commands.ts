// Типизированные обёртки над Tauri invoke(). Единственное место, где фронтенд знает имена команд.
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

/** В браузере без Tauri (UI-разработка) команды обслуживает мок. */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const invoke: typeof tauriInvoke = isTauri ? tauriInvoke : (cmd, args) => mockInvoke(cmd, args as Record<string, unknown>);

// --- Подключения -----------------------------------------------------------

export const listConnections = () => invoke<ConnectionConfig[]>("list_connections");

export const saveConnection = (input: ConnectionInput) =>
  invoke<ConnectionConfig>("save_connection", { input });

export const deleteConnection = (id: string) => invoke<void>("delete_connection", { id });

/** Проверка подключения без сохранения. */
export const testConnection = (input: ConnectionInput) =>
  invoke<ServerInfo>("test_connection", { input });

/** Открыть пул соединений для подключения (нужно перед любыми запросами). */
export const connect = (connectionId: string) => invoke<ServerInfo>("connect", { connectionId });

/** Закрыть пул и все сессии подключения. */
export const disconnect = (connectionId: string) => invoke<void>("disconnect", { connectionId });

// --- Схема -----------------------------------------------------------------

export const listDatabases = (connectionId: string) =>
  invoke<string[]>("list_databases", { connectionId });

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

// --- Выполнение ------------------------------------------------------------

/** Разбивает sql на выражения и выполняет их последовательно в сессии. */
export const executeQuery = (request: ExecuteRequest) =>
  invoke<StatementResult[]>("execute_query", { request });

/** KILL QUERY для запроса, запущенного с этим queryId. */
export const cancelQuery = (connectionId: string, queryId: string) =>
  invoke<void>("cancel_query", { connectionId, queryId });

/** Выполнить параметризованные выражения в одной транзакции (редактирование данных). */
export const applyChanges = (connectionId: string, sessionId: string, statements: ParamStatement[]) =>
  invoke<ApplyResult>("apply_changes", { connectionId, sessionId, statements });

/** Закрыть соединение сессии (при закрытии вкладки). */
export const closeSession = (connectionId: string, sessionId: string) =>
  invoke<void>("close_session", { connectionId, sessionId });

// --- История ---------------------------------------------------------------

export const listHistory = (limit = 200) => invoke<QueryHistoryEntry[]>("list_history", { limit });

export const clearHistory = () => invoke<void>("clear_history");
