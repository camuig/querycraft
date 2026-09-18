// Small Redis/Valkey helpers shared by the console and the explorer.

/** One-or-two-letter monogram for a Redis key's `TYPE`, shown in the explorer tree and the key data tab. */
export const KEY_TYPE_GLYPH: Record<string, string> = {
  string: "S",
  hash: "H",
  list: "L",
  set: "Se",
  zset: "Z",
  stream: "St",
};

/** Server-side `MATCH` pattern for the explorer's key filter box: "*" when empty, else "*substring*". */
export function keyMatchPattern(filter: string): string {
  const trimmed = filter.trim();
  return trimmed === "" ? "*" : `*${trimmed}*`;
}

/** Quotes a key name the way redis-cli expects a double-quoted argument: escapes `\` and `"`. */
export function quoteRedisKey(name: string): string {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Command that previews a key's value, picked by its Redis `TYPE`. Used by the explorer's default action. */
export function keyPreviewCommand(name: string, keyType: string): string {
  const key = quoteRedisKey(name);
  switch (keyType) {
    case "string":
      return `GET ${key}`;
    case "hash":
      return `HGETALL ${key}`;
    case "list":
      return `LRANGE ${key} 0 -1`;
    case "set":
      return `SMEMBERS ${key}`;
    case "zset":
      return `ZRANGE ${key} 0 -1 WITHSCORES`;
    case "stream":
      return `XRANGE ${key} - + COUNT 100`;
    default:
      return `TYPE ${key}`;
  }
}
