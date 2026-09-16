// Per-engine SQL conventions the frontend needs: identifier quoting, string
// literal escaping, defaults for the connection form and feature flags.
// The single source of truth for "what differs between engines" in the UI.

import type { DbKind } from "../api/types";

export interface Dialect {
  kind: DbKind;
  /** Product name shown in the UI ("MySQL", "PostgreSQL", ...). */
  label: string;
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
  defaultPort: number;
  defaultUser: string;
  defaultDatabase: string;
}

export const DIALECTS: Record<DbKind, Dialect> = {
  mysql: {
    kind: "mysql",
    label: "MySQL",
    identifierQuote: "`",
    backslashEscapes: true,
    namespaceLabel: "database",
    supportsEditing: true,
    fileBased: false,
    requiresDatabase: false,
    defaultPort: 3306,
    defaultUser: "root",
    defaultDatabase: "",
  },
  mariadb: {
    kind: "mariadb",
    label: "MariaDB",
    identifierQuote: "`",
    backslashEscapes: true,
    namespaceLabel: "database",
    supportsEditing: true,
    fileBased: false,
    requiresDatabase: false,
    defaultPort: 3306,
    defaultUser: "root",
    defaultDatabase: "",
  },
  postgres: {
    kind: "postgres",
    label: "PostgreSQL",
    identifierQuote: '"',
    backslashEscapes: false,
    namespaceLabel: "schema",
    supportsEditing: true,
    fileBased: false,
    requiresDatabase: true,
    defaultPort: 5432,
    defaultUser: "postgres",
    defaultDatabase: "postgres",
  },
  clickhouse: {
    kind: "clickhouse",
    label: "ClickHouse",
    identifierQuote: "`",
    backslashEscapes: true,
    namespaceLabel: "database",
    supportsEditing: false,
    fileBased: false,
    requiresDatabase: false,
    defaultPort: 8123,
    defaultUser: "default",
    defaultDatabase: "",
  },
  sqlite: {
    kind: "sqlite",
    label: "SQLite",
    identifierQuote: '"',
    backslashEscapes: false,
    namespaceLabel: "database",
    supportsEditing: true,
    fileBased: true,
    requiresDatabase: false,
    defaultPort: 0,
    defaultUser: "",
    defaultDatabase: "",
  },
};

/** Engines in the order they are offered in the connection dialog. */
export const DB_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "clickhouse", "sqlite"];

export function dialectFor(kind: DbKind): Dialect {
  return DIALECTS[kind];
}
