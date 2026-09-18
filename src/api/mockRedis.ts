// In-memory sample data for the mock Redis connection (browser dev only: `pnpm dev` without Tauri).
// Backs list_keys, execute_query and apply_changes for the "cache (mock)" connection so the Redis
// console, explorer and key data tab can all be exercised without a Tauri backend. Everything lives
// under database "0" — the other 15 mock databases are just empty.

import type { CellValue, ColumnMeta, KeyInfo, KeyListing, ParamStatement, StatementResult } from "./types";

interface Store {
  string: Record<string, string>;
  hash: Record<string, Record<string, string>>;
  list: Record<string, string[]>;
  set: Record<string, string[]>;
  zset: Record<string, [string, number][]>;
  stream: Record<string, { id: string; fields: string }[]>;
  ttl: Record<string, number | null>;
}

const store: Store = {
  string: { "session:abc123": "s3cr3t-token", "page:views": "1024" },
  hash: {
    "user:1": { name: "Alice", email: "alice@example.com", plan: "pro" },
    "user:2": { name: "Bob", email: "bob@example.com" },
  },
  list: { "queue:jobs": ["job-1", "job-2", "job-3"] },
  set: { tags: ["red", "green", "blue"] },
  zset: {
    leaderboard: [
      ["alice", 42],
      ["bob", 17],
    ],
  },
  stream: {
    events: [
      { id: "1700000000000-0", fields: "type login" },
      { id: "1700000000001-0", fields: "type logout" },
    ],
  },
  ttl: { "session:abc123": 3600 },
};

function keyTypeOf(name: string): string | null {
  if (name in store.string) return "string";
  if (name in store.hash) return "hash";
  if (name in store.list) return "list";
  if (name in store.set) return "set";
  if (name in store.zset) return "zset";
  if (name in store.stream) return "stream";
  return null;
}

function lengthOf(name: string, type: string): number {
  switch (type) {
    case "string":
      return store.string[name].length;
    case "hash":
      return Object.keys(store.hash[name]).length;
    case "list":
      return store.list[name].length;
    case "set":
      return store.set[name].length;
    case "zset":
      return store.zset[name].length;
    case "stream":
      return store.stream[name].length;
    default:
      return 0;
  }
}

function allKeyNames(): string[] {
  return [store.string, store.hash, store.list, store.set, store.zset, store.stream].flatMap((bucket) =>
    Object.keys(bucket),
  );
}

function deleteKey(key: string) {
  delete store.string[key];
  delete store.hash[key];
  delete store.list[key];
  delete store.set[key];
  delete store.zset[key];
  delete store.stream[key];
  delete store.ttl[key];
}

/** Turns a redis-cli glob pattern (`*`, `?`) into a RegExp, the same way `KEYS`/`SCAN MATCH` would. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function mockRedisKeys(database: string, pattern: string, limit: number): KeyListing {
  if (database !== "0") return { keys: [], truncated: false };
  const re = globToRegExp(pattern);
  const infos: KeyInfo[] = allKeyNames()
    .filter((name) => re.test(name))
    .map((name) => {
      const type = keyTypeOf(name) ?? "string";
      return { name, keyType: type, length: lengthOf(name, type), ttl: store.ttl[name] ?? null };
    });
  return { keys: infos.slice(0, limit), truncated: infos.length > limit };
}

/** Splits one redis-cli line into arguments: `"…"` with backslash escapes, `'…'`, or bare words. */
function tokenizeLine(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let arg = "";
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i];
      i++;
      while (i < line.length && line[i] !== quote) {
        if (quote === '"' && line[i] === "\\" && i + 1 < line.length) {
          arg += line[i + 1];
          i += 2;
        } else {
          arg += line[i];
          i++;
        }
      }
      i++;
    } else {
      while (i < line.length && !/\s/.test(line[i])) {
        arg += line[i];
        i++;
      }
    }
    args.push(arg);
  }
  return args;
}

const col = (name: string): ColumnMeta => ({
  name,
  table: null,
  database: null,
  typeName: "TEXT",
  unsigned: false,
  nullable: true,
  primaryKey: false,
  binary: false,
});

function rowsResult(sql: string, colNames: string[], rows: CellValue[][]): StatementResult {
  return {
    sql,
    kind: "rows",
    columns: colNames.map(col),
    rows,
    truncated: false,
    affectedRows: 0,
    lastInsertId: null,
    error: null,
    durationMs: 1,
  };
}

function affectedResult(sql: string, n: number): StatementResult {
  return {
    sql,
    kind: "affected",
    columns: [],
    rows: [],
    truncated: false,
    affectedRows: n,
    lastInsertId: null,
    error: null,
    durationMs: 1,
  };
}

function runOneCommand(line: string, database: string): StatementResult {
  const args = tokenizeLine(line);
  const cmd = (args[0] ?? "").toUpperCase();
  const key = args[1];
  const db0 = database === "0";

  switch (cmd) {
    case "GET":
      return rowsResult(line, ["value"], db0 && key in store.string ? [[store.string[key]]] : []);
    case "SET":
      if (db0 && key) store.string[key] = args[2] ?? "";
      return affectedResult(line, 1);
    case "HGETALL":
      return rowsResult(line, ["field", "value"], db0 ? Object.entries(store.hash[key] ?? {}) : []);
    case "LRANGE":
      return rowsResult(line, ["element"], db0 ? (store.list[key] ?? []).map((e) => [e]) : []);
    case "SMEMBERS":
      return rowsResult(line, ["member"], db0 ? (store.set[key] ?? []).map((m) => [m]) : []);
    case "ZRANGE":
      return rowsResult(line, ["member", "score"], db0 ? (store.zset[key] ?? []).map(([m, s]) => [m, s]) : []);
    case "XRANGE":
      return rowsResult(line, ["id", "fields"], db0 ? (store.stream[key] ?? []).map((e) => [e.id, e.fields]) : []);
    case "TTL":
      return rowsResult(line, ["value"], [[db0 ? (store.ttl[key] ?? -1) : -2]]);
    case "TYPE":
      return rowsResult(line, ["value"], [[db0 ? (keyTypeOf(key) ?? "none") : "none"]]);
    case "SELECT":
      return affectedResult(line, 0);
    default:
      applyOne(cmd, args.slice(1), database);
      return affectedResult(line, 1);
  }
}

/** One command from either a console line (`args`, string[]) or an apply_changes statement (`params`). */
function applyOne(cmd: string, p: string[], database: string) {
  if (database !== "0") return;
  switch (cmd) {
    case "SET":
      store.string[p[0]] = p[1];
      break;
    case "HSET":
      if (!store.hash[p[0]]) store.hash[p[0]] = {};
      store.hash[p[0]][p[1]] = p[2];
      break;
    case "HDEL":
      if (store.hash[p[0]]) delete store.hash[p[0]][p[1]];
      break;
    case "RPUSH":
      if (!store.list[p[0]]) store.list[p[0]] = [];
      store.list[p[0]].push(p[1]);
      break;
    case "LSET":
      if (store.list[p[0]]) store.list[p[0]][Number(p[1])] = p[2];
      break;
    case "LREM":
      if (store.list[p[0]]) store.list[p[0]] = store.list[p[0]].filter((e) => e !== p[2]);
      break;
    case "SADD":
      if (!store.set[p[0]]) store.set[p[0]] = [];
      if (!store.set[p[0]].includes(p[1])) store.set[p[0]].push(p[1]);
      break;
    case "SREM":
      if (store.set[p[0]]) store.set[p[0]] = store.set[p[0]].filter((m) => m !== p[1]);
      break;
    case "ZADD": {
      if (!store.zset[p[0]]) store.zset[p[0]] = [];
      const zset = store.zset[p[0]];
      const score = Number(p[1]);
      const idx = zset.findIndex(([m]) => m === p[2]);
      if (idx >= 0) zset[idx] = [p[2], score];
      else zset.push([p[2], score]);
      break;
    }
    case "ZREM":
      if (store.zset[p[0]]) store.zset[p[0]] = store.zset[p[0]].filter(([m]) => m !== p[1]);
      break;
    case "XDEL":
      if (store.stream[p[0]]) store.stream[p[0]] = store.stream[p[0]].filter((e) => e.id !== p[1]);
      break;
    case "DEL":
      deleteKey(p[0]);
      break;
    case "EXPIRE":
      store.ttl[p[0]] = Number(p[1]);
      break;
    case "PERSIST":
      store.ttl[p[0]] = null;
      break;
    default:
      break;
  }
}

/** One result set per non-blank, non-`#` line — mirrors how the real backend runs a Redis console. */
export function runRedisMockQuery(sql: string, database: string): StatementResult[] {
  return sql
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => runOneCommand(line, database));
}

/** Applies `apply_changes` statements from the key data tab (each `{ sql: COMMAND, params }`). */
export function applyRedisMockChanges(statements: ParamStatement[]): number {
  let database = "0";
  let affected = 0;
  for (const s of statements) {
    const p = s.params.map((v) => String(v));
    if (s.sql === "SELECT") {
      database = p[0];
      continue;
    }
    applyOne(s.sql, p, database);
    affected++;
  }
  return affected;
}
