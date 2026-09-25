import { beforeEach, describe, expect, it } from "vitest";
import type { ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, TableInfo } from "../../../api/types";
import { useConnectionsStore } from "../../../store/connectionsStore";
import { useExplorerStore } from "../../../store/explorerStore";
import { gatherSchemaContext } from "../gather";

function connectionConfig(overrides: Partial<ConnectionConfig> & { id: string }): ConnectionConfig {
  return {
    name: overrides.id,
    kind: "mysql",
    host: "localhost",
    port: 3306,
    user: "root",
    database: null,
    ssl: false,
    sslVerify: true,
    sslCaPath: null,
    color: null,
    path: null,
    ssh: null,
    hasPassword: false,
    hasSshSecret: false,
    aiAccess: "schema",
    ...overrides,
  };
}

function tableInfo(name: string): TableInfo {
  return { name, kind: "table", engine: null, rows: null, comment: "" };
}

function columnInfo(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    dataType: "int",
    columnType: "int",
    nullable: true,
    key: "",
    defaultValue: null,
    extra: "",
    comment: "",
    ordinal: 1,
    ...overrides,
  };
}

describe("gatherSchemaContext", () => {
  beforeEach(() => {
    useConnectionsStore.setState({ configs: [] });
    useExplorerStore.setState({
      tables: {},
      columns: {},
      indexes: {},
      foreignKeys: {},
      loadTables: async () => [],
      loadColumns: async () => [],
      loadIndexes: async () => [],
      loadForeignKeys: async () => [],
    });
  });

  it("returns an empty string for key-value engines (no relational schema)", async () => {
    useConnectionsStore.setState({ configs: [connectionConfig({ id: "c1", kind: "redis" })] });
    expect(await gatherSchemaContext("c1", "0", "GET foo")).toBe("");
  });

  it("returns an empty string when the connection has no tables", async () => {
    useConnectionsStore.setState({ configs: [connectionConfig({ id: "c1" })] });
    useExplorerStore.setState({ loadTables: async () => [] });
    expect(await gatherSchemaContext("c1", "shop", "select 1")).toBe("");
  });

  it("renders the mentioned table with its columns", async () => {
    useConnectionsStore.setState({ configs: [connectionConfig({ id: "c1" })] });
    useExplorerStore.setState({
      loadTables: async () => [tableInfo("orders")],
      loadColumns: async () => [columnInfo("id", { key: "PRI", nullable: false })],
      loadForeignKeys: async () => [],
    });
    const ctx = await gatherSchemaContext("c1", "shop", "SELECT * FROM orders");
    expect(ctx).toContain("CREATE TABLE orders (");
    expect(ctx).toContain("id int NOT NULL");
  });

  it("does not load indexes by default", async () => {
    let indexesLoaded = false;
    useConnectionsStore.setState({ configs: [connectionConfig({ id: "c1" })] });
    useExplorerStore.setState({
      loadTables: async () => [tableInfo("orders")],
      loadColumns: async () => [columnInfo("id", { key: "PRI" })],
      loadForeignKeys: async () => [],
      loadIndexes: async () => {
        indexesLoaded = true;
        return [];
      },
    });
    await gatherSchemaContext("c1", "shop", "SELECT * FROM orders");
    expect(indexesLoaded).toBe(false);
  });

  it("loads and renders indexes when includeIndexes is set", async () => {
    const indexInfo: IndexInfo = { name: "idx_email", unique: true, columns: ["email"], indexType: "BTREE" };
    useConnectionsStore.setState({ configs: [connectionConfig({ id: "c1" })] });
    useExplorerStore.setState({
      loadTables: async () => [tableInfo("users")],
      loadColumns: async () => [columnInfo("id", { key: "PRI" }), columnInfo("email", { ordinal: 2 })],
      loadForeignKeys: async () => [],
      loadIndexes: async () => [indexInfo],
    });
    const ctx = await gatherSchemaContext("c1", "shop", "SELECT * FROM users", { includeIndexes: true });
    expect(ctx).toContain("UNIQUE INDEX idx_email (email)");
  });

  it("swallows a failure to load indexes and still renders the table", async () => {
    useConnectionsStore.setState({ configs: [connectionConfig({ id: "c1" })] });
    useExplorerStore.setState({
      loadTables: async () => [tableInfo("users")],
      loadColumns: async () => [columnInfo("id", { key: "PRI" })],
      loadForeignKeys: async () => [],
      loadIndexes: async () => {
        throw new Error("boom");
      },
    });
    const ctx = await gatherSchemaContext("c1", "shop", "SELECT * FROM users", { includeIndexes: true });
    expect(ctx).toContain("CREATE TABLE users (");
  });

  it("swallows a failure to load tables and returns an empty string", async () => {
    useConnectionsStore.setState({ configs: [connectionConfig({ id: "c1" })] });
    useExplorerStore.setState({
      loadTables: async () => {
        throw new Error("boom");
      },
    });
    expect(await gatherSchemaContext("c1", "shop", "select 1")).toBe("");
  });

  it("swallows a per-table column/foreign-key load failure", async () => {
    useConnectionsStore.setState({ configs: [connectionConfig({ id: "c1" })] });
    useExplorerStore.setState({
      loadTables: async () => [tableInfo("orders")],
      loadColumns: async () => {
        throw new Error("boom");
      },
      loadForeignKeys: async () => {
        throw new Error("boom");
      },
    });
    const ctx = await gatherSchemaContext("c1", "shop", "SELECT * FROM orders");
    expect(ctx).toContain("columns not loaded");
  });

  it("falls back to the mysql dialect for an unknown connection id", async () => {
    useExplorerStore.setState({
      loadTables: async () => [tableInfo("t")],
      loadColumns: async () => [columnInfo("id", { key: "PRI" })],
      loadForeignKeys: async () => [],
    });
    const ctx = await gatherSchemaContext("missing", "shop", "select * from t");
    expect(ctx).toContain("CREATE TABLE t (");
  });

  it("expands the selection to a foreign-key neighbor and renders the relationship", async () => {
    const fk: ForeignKeyInfo = {
      name: "fk_user",
      columns: ["user_id"],
      refDatabase: "shop",
      refTable: "users",
      refColumns: ["id"],
      onUpdate: "RESTRICT",
      onDelete: "RESTRICT",
    };
    useConnectionsStore.setState({ configs: [connectionConfig({ id: "c1" })] });
    useExplorerStore.setState({
      loadTables: async () => [tableInfo("orders"), tableInfo("users")],
      loadColumns: async (_cid, _db, table) =>
        table === "orders"
          ? [columnInfo("id", { key: "PRI" }), columnInfo("user_id", { ordinal: 2 })]
          : [columnInfo("id", { key: "PRI" })],
      loadForeignKeys: async (_cid, _db, table) => (table === "orders" ? [fk] : []),
    });
    const ctx = await gatherSchemaContext("c1", "shop", "SELECT * FROM orders");
    expect(ctx).toContain("FOREIGN KEY (user_id) REFERENCES users(id)");
    expect(ctx).toContain("CREATE TABLE users (");
  });
});
