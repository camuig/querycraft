import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "../../../api/types";
import { buildTree, type TreeModelInput } from "../treeModel";

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
