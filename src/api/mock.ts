// Mock IPC for UI development in a plain browser (without Tauri): `pnpm dev` and open http://localhost:1420.
// Activated only when window.__TAURI_INTERNALS__ is absent. Not used in the application build.
import type {
  ColumnInfo,
  ColumnMeta,
  ConnectionConfig,
  ConnectionInput,
  ExecuteRequest,
  StatementResult,
  TableInfo,
} from "./types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let connections: ConnectionConfig[] = [
  {
    id: "mock-1",
    name: "local (mock)",
    host: "localhost",
    port: 3306,
    user: "root",
    database: "shop",
    ssl: false,
    sslVerify: true,
    color: "#3574f0",
    hasPassword: true,
  },
  {
    id: "mock-2",
    name: "prod (mock)",
    host: "db.example.com",
    port: 3306,
    user: "app",
    database: null,
    ssl: true,
    sslVerify: true,
    color: "#e55765",
    hasPassword: false,
  },
];

const tables: Record<string, TableInfo[]> = {
  shop: [
    { name: "customers", kind: "table", engine: "InnoDB", rows: 3, comment: "Customers" },
    { name: "orders", kind: "table", engine: "InnoDB", rows: 3, comment: "" },
    { name: "products", kind: "table", engine: "InnoDB", rows: 3, comment: "" },
    { name: "big_table", kind: "table", engine: "InnoDB", rows: 100000, comment: "" },
    { name: "active_customers", kind: "view", engine: null, rows: null, comment: "" },
  ],
  information_schema: [{ name: "TABLES", kind: "view", engine: null, rows: null, comment: "" }],
};

const col = (
  name: string,
  dataType: string,
  columnType: string,
  key = "",
  nullable = true,
  ordinal = 1,
): ColumnInfo => ({
  name,
  dataType,
  columnType,
  nullable,
  key,
  defaultValue: null,
  extra: key === "PRI" ? "auto_increment" : "",
  comment: "",
  ordinal,
});
const columns: Record<string, ColumnInfo[]> = {
  customers: [
    col("id", "int", "int unsigned", "PRI", false, 1),
    col("email", "varchar", "varchar(255)", "UNI", false, 2),
    col("name", "varchar", "varchar(100)", "", false, 3),
    col("balance", "decimal", "decimal(12,2)", "", false, 4),
    col("birth_date", "date", "date", "", true, 5),
    col("meta", "json", "json", "", true, 6),
  ],
  orders: [
    col("id", "bigint", "bigint", "PRI", false, 1),
    col("customer_id", "int", "int unsigned", "MUL", false, 2),
    col("status", "enum", "enum('new','paid')", "", false, 3),
    col("total", "decimal", "decimal(12,2)", "", false, 4),
  ],
  products: [
    col("id", "int", "int", "PRI", false, 1),
    col("title", "varchar", "varchar(200)", "", false, 2),
    col("price", "decimal", "decimal(10,2)", "", false, 3),
  ],
  big_table: [
    col("id", "int", "int", "PRI", false, 1),
    col("v", "int", "int", "", true, 2),
    col("s", "varchar", "varchar(50)", "", true, 3),
    col("d", "datetime", "datetime", "", true, 4),
  ],
  active_customers: [
    col("id", "int", "int unsigned", "", false, 1),
    col("email", "varchar", "varchar(255)", "", false, 2),
  ],
};

const meta = (name: string, typeName: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  table: null,
  database: "shop",
  typeName,
  unsigned: false,
  nullable: true,
  primaryKey: false,
  binary: false,
  ...extra,
});

const customerRows = [
  [1, "alice@example.com", "Alice", "100.50", "1990-05-01", '{"vip": true}'],
  [2, "bob@example.com", "Bob", "0.00", null, null],
  [3, "carol@example.com", "Carol", "-12.25", "1985-12-31", "[1,2,3]"],
];

function rowsResult(
  sql: string,
  cols: ColumnMeta[],
  rows: StatementResult["rows"],
  truncated = false,
): StatementResult {
  return {
    sql,
    kind: "rows",
    columns: cols,
    rows,
    truncated,
    affectedRows: 0,
    lastInsertId: null,
    error: null,
    durationMs: Math.round(Math.random() * 40),
  };
}

function runStatement(sql: string, maxRows: number): StatementResult {
  const s = sql.trim().replace(/;$/, "");
  const lower = s.toLowerCase();
  if (lower.includes("nope")) {
    return {
      sql,
      kind: "error",
      columns: [],
      rows: [],
      truncated: false,
      affectedRows: 0,
      lastInsertId: null,
      error: "[1146] Table 'shop.nope' doesn't exist",
      durationMs: 1,
    };
  }
  if (/^(insert|update|delete|create|drop|alter|use|set)\b/.test(lower)) {
    return {
      sql,
      kind: "affected",
      columns: [],
      rows: [],
      truncated: false,
      affectedRows: lower.startsWith("insert") ? 1 : 3,
      lastInsertId: lower.startsWith("insert") ? 42 : null,
      error: null,
      durationMs: 3,
    };
  }
  if (lower.includes("count(*)")) {
    return rowsResult(
      sql,
      [meta("COUNT(*)", "BIGINT", { nullable: false })],
      [[lower.includes("big_table") ? 100000 : 3]],
    );
  }
  if (lower.includes("big_table")) {
    const offset = Number(/offset\s+(\d+)/.exec(lower)?.[1] ?? 0);
    const limit = Math.min(maxRows, Number(/limit\s+(\d+)/.exec(lower)?.[1] ?? maxRows));
    const rows = Array.from({ length: limit }, (_, i) => {
      const id = offset + i + 1;
      return [id, id * 7, `row-${id}`, `2024-01-01 12:${String(id % 60).padStart(2, "0")}:00`];
    });
    return rowsResult(
      sql,
      [
        meta("id", "INT", { primaryKey: true, nullable: false, table: "big_table" }),
        meta("v", "INT", { table: "big_table" }),
        meta("s", "VARCHAR", { table: "big_table" }),
        meta("d", "DATETIME", { table: "big_table" }),
      ],
      rows,
      offset + limit < 100000,
    );
  }
  return rowsResult(
    sql,
    [
      meta("id", "INT", { primaryKey: true, nullable: false, unsigned: true, table: "customers" }),
      meta("email", "VARCHAR", { nullable: false, table: "customers" }),
      meta("name", "VARCHAR", { nullable: false, table: "customers" }),
      meta("balance", "DECIMAL", { nullable: false, table: "customers" }),
      meta("birth_date", "DATE", { table: "customers" }),
      meta("meta", "JSON", { table: "customers" }),
    ],
    customerRows,
  );
}

export async function mockInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await delay(cmd === "connect" ? 400 : 60);
  const a = args as Record<string, string>;
  switch (cmd) {
    case "list_connections":
      return connections as T;
    case "save_connection": {
      const input = args.input as ConnectionInput;
      const saved: ConnectionConfig = {
        id: input.id ?? `mock-${Date.now()}`,
        name: input.name,
        host: input.host,
        port: input.port,
        user: input.user,
        database: input.database,
        ssl: input.ssl,
        sslVerify: input.sslVerify,
        color: input.color,
        hasPassword: input.savePassword && !!input.password,
      };
      connections = connections.some((c) => c.id === saved.id)
        ? connections.map((c) => (c.id === saved.id ? saved : c))
        : [...connections, saved];
      return saved as T;
    }
    case "delete_connection":
      connections = connections.filter((c) => c.id !== a.id);
      return undefined as T;
    case "test_connection":
    case "connect":
      return { serverVersion: "8.0.44-mock", connectionId: 7 } as T;
    case "disconnect":
    case "close_session":
    case "cancel_query":
    case "clear_history":
      return undefined as T;
    case "list_databases":
      return ["information_schema", "shop"] as T;
    case "list_tables":
      return (tables[a.database] ?? []) as T;
    case "list_columns":
      return (columns[a.table] ?? []) as T;
    case "list_indexes":
      return (
        a.table === "orders"
          ? [
              { name: "PRIMARY", unique: true, columns: ["id"], indexType: "BTREE" },
              { name: "idx_customer", unique: false, columns: ["customer_id", "status"], indexType: "BTREE" },
            ]
          : [{ name: "PRIMARY", unique: true, columns: ["id"], indexType: "BTREE" }]
      ) as T;
    case "list_foreign_keys":
      return (
        a.table === "orders"
          ? [
              {
                name: "fk_orders_customer",
                columns: ["customer_id"],
                refDatabase: "shop",
                refTable: "customers",
                refColumns: ["id"],
                onUpdate: "RESTRICT",
                onDelete: "CASCADE",
              },
            ]
          : []
      ) as T;
    case "get_table_ddl":
      return `CREATE TABLE \`${a.table}\` (\n  \`id\` int NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` as T;
    case "execute_query": {
      const req = args.request as ExecuteRequest;
      if (req.sql.toLowerCase().includes("sleep")) await delay(5000);
      const parts = req.sql
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean);
      const out: StatementResult[] = [];
      for (const p of parts) {
        const r = runStatement(p, req.maxRows);
        out.push(r);
        if (r.kind === "error" && req.stopOnError) break;
      }
      return out as T;
    }
    case "apply_changes":
      return { affectedRows: (args.statements as unknown[]).length, durationMs: 12 } as T;
    case "list_history":
      return [] as T;
    default:
      throw new Error(`mock: unknown command ${cmd}`);
  }
}
