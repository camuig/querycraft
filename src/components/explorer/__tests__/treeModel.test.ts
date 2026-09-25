import { describe, expect, it } from "vitest";
import type { ConnectionConfig, KeyListing } from "../../../api/types";
import { keysKey } from "../../../store/explorerStore";
import { buildTree, fmtCount, type TreeModelInput } from "../treeModel";

function conn(id: string, name: string, kind: ConnectionConfig["kind"]): ConnectionConfig {
  return {
    id,
    name,
    kind,
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
  };
}

function baseInput(connections: ConnectionConfig[]): TreeModelInput {
  return {
    connections,
    runtimeStatus: {},
    databases: {},
    tables: {},
    columns: {},
    indexes: {},
    foreignKeys: {},
    keys: {},
    loading: {},
    errors: {},
    expanded: {},
    filter: "",
  };
}

describe("buildTree", () => {
  it("carries dbKind on connection nodes", () => {
    const input = baseInput([conn("c1", "mysql conn", "mysql"), conn("c2", "pg conn", "postgres")]);
    const tree = buildTree(input);

    expect(tree).toHaveLength(2);
    expect(tree[0]).toMatchObject({ key: "c1", kind: "connection", dbKind: "mysql" });
    expect(tree[1]).toMatchObject({ key: "c2", kind: "connection", dbKind: "postgres" });
  });

  it("leaves the rest of a basic tree unchanged", () => {
    const input = baseInput([conn("c1", "mysql conn", "mysql")]);
    const tree = buildTree(input);

    expect(tree).toEqual([
      {
        key: "c1",
        kind: "connection",
        depth: 0,
        connectionId: "c1",
        label: "mysql conn",
        secondary: undefined,
        expandable: true,
        colorHex: null,
        statusColor: "var(--fg-dim)",
        dbKind: "mysql",
      },
    ]);
  });
});

describe("buildTree — Redis/Valkey", () => {
  function listing(keys: KeyListing["keys"], truncated = false): KeyListing {
    return { keys, truncated };
  }

  it("shows a single Keys group under a database instead of Tables/Views", () => {
    const input: TreeModelInput = {
      ...baseInput([conn("c1", "redis conn", "redis")]),
      databases: { c1: ["0", "1"] },
      expanded: { c1: true, "c1/0": true },
      keys: { [keysKey("c1", "0", "*")]: listing([{ name: "user:1", keyType: "string", length: 5, ttl: null }]) },
    };
    const tree = buildTree(input);

    const groupNode = tree.find((n) => n.key === "c1/0#group-keys");
    expect(groupNode).toMatchObject({ kind: "group-keys", label: "Keys", secondary: "1", expandable: true });
    expect(tree.some((n) => n.kind === "group-tables")).toBe(false);
    expect(tree.some((n) => n.kind === "group-views")).toBe(false);
  });

  it("renders key nodes with type, length and TTL when the Keys group is expanded", () => {
    const input: TreeModelInput = {
      ...baseInput([conn("c1", "redis conn", "redis")]),
      databases: { c1: ["0"] },
      expanded: { c1: true, "c1/0": true, "c1/0#group-keys": true },
      keys: {
        [keysKey("c1", "0", "*")]: listing([
          { name: "user:1", keyType: "hash", length: 12, ttl: 3600 },
          { name: "counter", keyType: "string", length: null, ttl: null },
        ]),
      },
    };
    const tree = buildTree(input);

    const hashKey = tree.find((n) => n.label === "user:1");
    expect(hashKey).toMatchObject({
      kind: "key",
      keyType: "hash",
      secondary: "hash · 12",
      title: "TTL 3600 s",
      expandable: false,
    });

    const stringKey = tree.find((n) => n.label === "counter");
    expect(stringKey).toMatchObject({ kind: "key", keyType: "string", secondary: "string", title: undefined });
  });

  it("marks the Keys group truncated with a `+` suffix on the count", () => {
    const input: TreeModelInput = {
      ...baseInput([conn("c1", "redis conn", "redis")]),
      databases: { c1: ["0"] },
      expanded: { c1: true, "c1/0": true },
      keys: {
        [keysKey("c1", "0", "*")]: listing(
          Array.from({ length: 1000 }, (_, i) => ({ name: `k${i}`, keyType: "string", length: 1, ttl: null })),
          true,
        ),
      },
    };
    const tree = buildTree(input);
    const groupNode = tree.find((n) => n.key === "c1/0#group-keys");
    expect(groupNode?.secondary).toBe(`${fmtCount(1000)}+`);
  });

  it("shows a loading placeholder while keys are being fetched, instead of the Keys group", () => {
    const input: TreeModelInput = {
      ...baseInput([conn("c1", "redis conn", "redis")]),
      databases: { c1: ["0"] },
      expanded: { c1: true, "c1/0": true },
      loading: { [keysKey("c1", "0", "*")]: true },
    };
    const tree = buildTree(input);
    expect(tree.some((n) => n.kind === "group-keys")).toBe(false);
    expect(tree.some((n) => n.kind === "loading")).toBe(true);
  });

  it("shows an error placeholder when the key listing failed, instead of the Keys group", () => {
    const input: TreeModelInput = {
      ...baseInput([conn("c1", "redis conn", "redis")]),
      databases: { c1: ["0"] },
      expanded: { c1: true, "c1/0": true },
      errors: { [keysKey("c1", "0", "*")]: "connection refused" },
    };
    const tree = buildTree(input);
    const errorNode = tree.find((n) => n.kind === "error");
    expect(errorNode?.label).toBe("connection refused");
  });

  it("filters database names locally but never filters key names", () => {
    const input: TreeModelInput = {
      ...baseInput([conn("c1", "redis conn", "redis")]),
      databases: { c1: ["0", "1"] },
      expanded: { c1: true, "c1/0": true, "c1/1": true, "c1/0#group-keys": true },
      filter: "0",
      keys: { [keysKey("c1", "0", "*0*")]: listing([{ name: "anything", keyType: "string", length: 1, ttl: null }]) },
    };
    const tree = buildTree(input);
    expect(tree.some((n) => n.kind === "database" && n.database === "0")).toBe(true);
    expect(tree.some((n) => n.kind === "database" && n.database === "1")).toBe(false);
    // The key listing was loaded with the pattern derived from the filter, not filtered again here.
    expect(tree.some((n) => n.kind === "key" && n.label === "anything")).toBe(true);
  });
});
