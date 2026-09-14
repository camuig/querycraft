// Контракт между фронтендом и Rust-бэкендом. Зеркало структур в src-tauri/src.
// Все поля в camelCase (serde rename_all = "camelCase" на стороне Rust).

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** База данных по умолчанию (может быть пустой). */
  database: string | null;
  ssl: boolean;
  /** Цвет метки подключения (hex) — как в DataGrip для prod/dev. */
  color: string | null;
  /** Есть ли сохранённый пароль в keyring. */
  hasPassword: boolean;
}

/** То, что фронтенд отправляет при сохранении/тесте подключения. */
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
  /** CONNECTION_ID() сессии (для отладки). */
  connectionId: number;
}

export type TableKind = "table" | "view";

export interface TableInfo {
  name: string;
  kind: TableKind;
  engine: string | null;
  /** Приблизительное число строк из information_schema. */
  rows: number | null;
  comment: string;
}

export interface ColumnInfo {
  name: string;
  /** Например "int", "varchar". */
  dataType: string;
  /** Полный тип, например "varchar(255)", "int unsigned". */
  columnType: string;
  nullable: boolean;
  /** "PRI" | "UNI" | "MUL" | "" */
  key: string;
  defaultValue: string | null;
  /** auto_increment, on update ... */
  extra: string;
  comment: string;
  /** Порядковый номер, начиная с 1. */
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
 * Значение ячейки в JSON:
 *  - null — SQL NULL
 *  - number — целые в пределах safe integer, float/double
 *  - string — всё остальное (текст, decimal, большие целые, даты как "YYYY-MM-DD HH:MM:SS", бинарные как "0x...")
 *  - boolean — не используется бэкендом, но допускается при редактировании
 */
export type CellValue = null | number | string | boolean;

export interface ColumnMeta {
  name: string;
  /** Исходная таблица (если известна). */
  table: string | null;
  database: string | null;
  /** Имя типа MySQL в верхнем регистре: "VARCHAR", "INT", "DATETIME", "DECIMAL", "BLOB", "JSON"... */
  typeName: string;
  unsigned: boolean;
  nullable: boolean;
  primaryKey: boolean;
  /** Бинарные данные (BLOB/BINARY) — редактирование недоступно в MVP. */
  binary: boolean;
}

export type StatementResultKind = "rows" | "affected" | "error";

export interface StatementResult {
  /** Текст выполненного выражения. */
  sql: string;
  kind: StatementResultKind;
  columns: ColumnMeta[];
  rows: CellValue[][];
  /** true, если строки обрезаны по лимиту maxRows. */
  truncated: boolean;
  affectedRows: number;
  lastInsertId: number | null;
  error: string | null;
  durationMs: number;
}

export interface ExecuteRequest {
  connectionId: string;
  /** Идентификатор сессии (вкладки) — своё соединение MySQL. Создаётся лениво. */
  sessionId: string;
  /** Идентификатор запроса для отмены. */
  queryId: string;
  sql: string;
  /** Лимит строк на один результат (по умолчанию 500). */
  maxRows: number;
  /** Если задано — выполнить USE перед запросом (для новой сессии). */
  database: string | null;
  /** Прекращать выполнение при первой ошибке. */
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
