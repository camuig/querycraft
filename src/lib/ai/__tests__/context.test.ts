import { describe, expect, it } from "vitest";
import type { ColumnInfo, ForeignKeyInfo } from "../../../api/types";
import { buildSchemaContext, type RenderableTable, renderTable, selectRelevantTables } from "../context";

function col(overrides: Partial<ColumnInfo> & { name: string; ordinal: number }): ColumnInfo {
  return {
    dataType: "int",
    columnType: "int",
    nullable: true,
    key: "",
    defaultValue: null,
    extra: "",
    comment: "",
    ...overrides,
  };
}

function fk(overrides: Partial<ForeignKeyInfo> = {}): ForeignKeyInfo {
  return {
    name: "fk",
    columns: [],
    refDatabase: "shop",
    refTable: "",
    refColumns: [],
    onUpdate: "RESTRICT",
    onDelete: "RESTRICT",
    ...overrides,
  };
}

describe("renderTable", () => {
  it("renders a compact CREATE TABLE matching the reference example", () => {
    const table: RenderableTable = {
      name: "orders",
      kind: "table",
      comment: "customer orders",
      columns: [
        col({ name: "id", ordinal: 1, columnType: "int", nullable: false, key: "PRI", extra: "auto_increment" }),
        col({ name: "user_id", ordinal: 2, columnType: "int", nullable: false }),
        col({
          name: "status",
          ordinal: 3,
          columnType: "enum('new','paid')",
          nullable: true,
          defaultValue: "new",
          comment: "order state",
        }),
      ],
      foreignKeys: [fk({ columns: ["user_id"], refTable: "users", refColumns: ["id"] })],
    };

    expect(renderTable(table)).toBe(
      [
        "CREATE TABLE orders ( -- customer orders",
        "  id int NOT NULL PRIMARY KEY auto_increment,",
        "  user_id int NOT NULL,",
        "  status enum('new','paid') DEFAULT 'new', -- order state",
        "  FOREIGN KEY (user_id) REFERENCES users(id)",
        ");",
      ].join("\n"),
    );
  });

  it("renders a placeholder when columns have not been loaded yet", () => {
    expect(renderTable({ name: "x", kind: "table" })).toBe("CREATE TABLE x (...); -- columns not loaded");
  });

  it("uses CREATE VIEW for views", () => {
    const table: RenderableTable = {
      name: "active_customers",
      kind: "view",
      columns: [col({ name: "id", ordinal: 1, key: "PRI", nullable: false })],
    };
    expect(renderTable(table).startsWith("CREATE VIEW active_customers (")).toBe(true);
  });

  it("omits the header comment when the table has none, and orders columns by ordinal", () => {
    const table: RenderableTable = {
      name: "t",
      kind: "table",
      columns: [col({ name: "b", ordinal: 2 }), col({ name: "a", ordinal: 1 })],
    };
    const rendered = renderTable(table);
    expect(rendered.startsWith("CREATE TABLE t (\n")).toBe(true);
    expect(rendered.indexOf("a int")).toBeLessThan(rendered.indexOf("b int"));
  });

  it("keeps a numeric or keyword default unquoted", () => {
    const table: RenderableTable = {
      name: "t",
      kind: "table",
      columns: [
        col({ name: "n", ordinal: 1, defaultValue: "0" }),
        col({ name: "created_at", ordinal: 2, defaultValue: "CURRENT_TIMESTAMP" }),
      ],
    };
    const rendered = renderTable(table);
    expect(rendered).toContain("DEFAULT 0");
    expect(rendered).toContain("DEFAULT CURRENT_TIMESTAMP");
  });
});

describe("selectRelevantTables", () => {
  it("returns every table when there are no more than the limit", () => {
    const names = ["b", "a", "c"];
    expect(selectRelevantTables(names, "nothing relevant here", {}, 40)).toEqual(names);
  });

  function manyNames(mentioned: string[]): string[] {
    const filler = Array.from({ length: 40 }, (_, i) => `filler_${i}`);
    return [...filler, ...mentioned];
  }

  it("picks only the tables mentioned in the text, plus their FK neighbors, above the limit", () => {
    const names = manyNames(["orders", "customers", "products"]);
    const fkNeighbors = { orders: ["customers"] };
    const selected = selectRelevantTables(names, "SELECT * FROM orders", fkNeighbors, 40);
    expect(selected).toEqual(["orders", "customers"]);
  });

  it("keeps the original relative order of the selected tables", () => {
    const names = manyNames(["products", "orders"]);
    const selected = selectRelevantTables(names, "join orders and products", {}, 40);
    // "products" appears before "orders" in `names`, so it stays first even though the text
    // mentions "orders" first.
    expect(selected).toEqual(["products", "orders"]);
  });

  it("tolerates a singular mention of a plural table name and vice versa", () => {
    const names = manyNames(["categories", "customers"]);
    expect(selectRelevantTables(names, "list every category", {}, 40)).toContain("categories");
    expect(selectRelevantTables(names, "find one customer", {}, 40)).toContain("customers");
  });

  it("matches a schema-qualified table by the part after the last dot", () => {
    const names = manyNames(["sales.invoice"]);
    expect(selectRelevantTables(names, "select * from invoice", {}, 40)).toContain("sales.invoice");
  });

  it("caps the result at the limit even when more tables match", () => {
    const mentioned = Array.from({ length: 5 }, (_, i) => `hit_${i}`);
    const names = manyNames(mentioned);
    const text = mentioned.join(" ");
    expect(selectRelevantTables(names, text, {}, 3).length).toBe(3);
  });
});

describe("buildSchemaContext", () => {
  it("renders every table and adds no note when everything fits", () => {
    const tables: RenderableTable[] = [
      { name: "a", kind: "table", columns: [col({ name: "id", ordinal: 1 })] },
      { name: "b", kind: "table", columns: [col({ name: "id", ordinal: 1 })] },
    ];
    const out = buildSchemaContext(tables, "irrelevant text");
    expect(out).toContain("CREATE TABLE a (");
    expect(out).toContain("CREATE TABLE b (");
    expect(out).not.toContain("Other tables");
  });

  it("lists tables that were left out under a single note", () => {
    const filler = Array.from({ length: 40 }, (_, i) => ({
      name: `filler_${i}`,
      kind: "table" as const,
      columns: [col({ name: "id", ordinal: 1 })],
    }));
    const tables: RenderableTable[] = [
      ...filler,
      { name: "orders", kind: "table", columns: [col({ name: "id", ordinal: 1 })] },
    ];
    const out = buildSchemaContext(tables, "SELECT * FROM orders", { limit: 40 });
    expect(out).toContain("CREATE TABLE orders (");
    expect(out).toContain("-- Other tables:");
    expect(out).toContain("filler_0");
  });

  it("stops adding tables once the character budget is spent and still notes the rest", () => {
    const tables: RenderableTable[] = [
      { name: "a", kind: "table", columns: [col({ name: "id", ordinal: 1 })] },
      { name: "b", kind: "table", columns: [col({ name: "id", ordinal: 1 })] },
    ];
    // Room for table "a" in full, plus a short "-- Other tables: b" note, but not a second table.
    const maxChars = renderTable(tables[0]).length + 20;
    const out = buildSchemaContext(tables, "irrelevant", { maxChars });
    expect(out).toContain("CREATE TABLE a (");
    expect(out).not.toContain("CREATE TABLE b (");
    expect(out).toContain("-- Other tables:");
    expect(out).toContain("b");
  });

  it("drops the 'other tables' note entirely when even that does not fit the budget", () => {
    const tables: RenderableTable[] = Array.from({ length: 100 }, (_, i) => ({
      name: `some_long_table_name_${i}`,
      kind: "table" as const,
    }));
    // Too small for even the shortest possible note ("-- Other tables: ...and N more").
    expect(buildSchemaContext(tables, "irrelevant", { maxChars: 10, limit: 200 })).toBe("");
  });
});
