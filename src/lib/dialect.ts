// Per-engine SQL conventions the frontend needs: identifier quoting, string
// literal escaping, defaults for the connection form and feature flags.
// The single source of truth for "what differs between engines" in the UI.

import type { DbKind, QueryLanguage } from "../api/types";

export interface Dialect {
  kind: DbKind;
  /** Product name shown in the UI ("MySQL", "PostgreSQL", ...). */
  label: string;
  /**
   * What the console speaks: SQL (statements split at `;`, schema-aware editor, tables in the explorer)
   * or Redis commands (one per line, key listing in the explorer, no row editing).
   */
  queryLanguage: QueryLanguage;
  /** Character that wraps identifiers: backtick (MySQL family, ClickHouse) or double quote (PostgreSQL, SQLite). */
  identifierQuote: "`" | '"';
  /** Whether `\` escapes characters inside string literals (MySQL, ClickHouse) or only doubling the quote works. */
  backslashEscapes: boolean;
  /** What the level below the connection is called in the explorer: databases or (PostgreSQL) schemas. */
  namespaceLabel: "database" | "schema";
  /** Grid editing (UPDATE/DELETE by primary key) is available. ClickHouse has no row-level updates. */
  supportsEditing: boolean;
  /** The connection is a local file instead of host/port/user (SQLite). */
  fileBased: boolean;
  /** A database name is mandatory to connect (PostgreSQL connects to exactly one database). */
  requiresDatabase: boolean;
  /**
   * How a row limit is expressed in generated SELECTs: a trailing `LIMIT n [OFFSET m]`
   * (MySQL family, PostgreSQL, ClickHouse, SQLite) or SQL Server's `OFFSET m ROWS FETCH NEXT n ROWS ONLY`
   * (which requires an ORDER BY).
   */
  rowLimit: "limit" | "fetch";
  /**
   * Identifier names may carry dots that separate parts to quote individually
   * (SQL Server tables are listed as `schema.table` and quoted `[schema].[table]`).
   */
  dottedIdentifier: boolean;
  defaultPort: number;
  defaultUser: string;
  defaultDatabase: string;
}

export const DIALECTS: Record<DbKind, Dialect> = {
  mysql: {
    kind: "mysql",
    label: "MySQL",
    queryLanguage: "sql",
    identifierQuote: "`",
    backslashEscapes: true,
    namespaceLabel: "database",
    supportsEditing: true,
    fileBased: false,
    requiresDatabase: false,
    rowLimit: "limit",
    dottedIdentifier: false,
    defaultPort: 3306,
    defaultUser: "root",
    defaultDatabase: "",
  },
  mariadb: {
    kind: "mariadb",
    label: "MariaDB",
    queryLanguage: "sql",
    identifierQuote: "`",
    backslashEscapes: true,
    namespaceLabel: "database",
    supportsEditing: true,
    fileBased: false,
    requiresDatabase: false,
    rowLimit: "limit",
    dottedIdentifier: false,
    defaultPort: 3306,
    defaultUser: "root",
    defaultDatabase: "",
  },
  postgres: {
    kind: "postgres",
    label: "PostgreSQL",
    queryLanguage: "sql",
    identifierQuote: '"',
    backslashEscapes: false,
    namespaceLabel: "schema",
    supportsEditing: true,
    fileBased: false,
    requiresDatabase: true,
    rowLimit: "limit",
    dottedIdentifier: false,
    defaultPort: 5432,
    defaultUser: "postgres",
    defaultDatabase: "postgres",
  },
  clickhouse: {
    kind: "clickhouse",
    label: "ClickHouse",
    queryLanguage: "sql",
    identifierQuote: "`",
    backslashEscapes: true,
    namespaceLabel: "database",
    supportsEditing: false,
    fileBased: false,
    requiresDatabase: false,
    rowLimit: "limit",
    dottedIdentifier: false,
    defaultPort: 8123,
    defaultUser: "default",
    defaultDatabase: "",
  },
  sqlite: {
    kind: "sqlite",
    label: "SQLite",
    queryLanguage: "sql",
    identifierQuote: '"',
    backslashEscapes: false,
    namespaceLabel: "database",
    supportsEditing: true,
    fileBased: true,
    requiresDatabase: false,
    rowLimit: "limit",
    dottedIdentifier: false,
    defaultPort: 0,
    defaultUser: "",
    defaultDatabase: "",
  },
  redis: {
    kind: "redis",
    label: "Redis",
    queryLanguage: "redis",
    identifierQuote: '"',
    backslashEscapes: true,
    namespaceLabel: "database",
    supportsEditing: false,
    fileBased: false,
    requiresDatabase: false,
    rowLimit: "limit",
    dottedIdentifier: false,
    defaultPort: 6379,
    defaultUser: "",
    defaultDatabase: "0",
  },
  valkey: {
    kind: "valkey",
    label: "Valkey",
    queryLanguage: "redis",
    identifierQuote: '"',
    backslashEscapes: true,
    namespaceLabel: "database",
    supportsEditing: false,
    fileBased: false,
    requiresDatabase: false,
    rowLimit: "limit",
    dottedIdentifier: false,
    defaultPort: 6379,
    defaultUser: "",
    defaultDatabase: "0",
  },
  mssql: {
    kind: "mssql",
    label: "SQL Server",
    queryLanguage: "sql",
    identifierQuote: '"',
    backslashEscapes: false,
    namespaceLabel: "database",
    supportsEditing: true,
    fileBased: false,
    requiresDatabase: false,
    rowLimit: "fetch",
    dottedIdentifier: true,
    defaultPort: 1433,
    defaultUser: "sa",
    defaultDatabase: "",
  },
};

/** Engines in the order they are offered in the connection dialog. */
export const DB_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "mssql", "clickhouse", "sqlite", "redis", "valkey"];

export function dialectFor(kind: DbKind): Dialect {
  return DIALECTS[kind];
}
