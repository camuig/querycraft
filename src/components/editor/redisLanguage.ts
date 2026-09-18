// CodeMirror language for the Redis/Valkey console: one command per line, redis-cli syntax
// (`#` line comments, double-quoted strings with backslash escapes, single-quoted strings).
// Not a full grammar — Redis has no nested expressions — just enough to highlight commands,
// strings and numbers and to drive autocomplete.

import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

/** [name, short argument signature shown as the completion detail]. */
export const REDIS_COMMANDS: [string, string][] = [
  // Strings
  ["SET", "key value [EX seconds|PX ms] [NX|XX] [GET]"],
  ["GET", "key"],
  ["GETSET", "key value"],
  ["GETDEL", "key"],
  ["GETEX", "key [EX seconds|PX ms|PERSIST]"],
  ["MSET", "key value [key value ...]"],
  ["MGET", "key [key ...]"],
  ["MSETNX", "key value [key value ...]"],
  ["SETNX", "key value"],
  ["SETEX", "key seconds value"],
  ["PSETEX", "key ms value"],
  ["APPEND", "key value"],
  ["STRLEN", "key"],
  ["INCR", "key"],
  ["DECR", "key"],
  ["INCRBY", "key increment"],
  ["DECRBY", "key decrement"],
  ["INCRBYFLOAT", "key increment"],
  ["GETRANGE", "key start end"],
  ["SETRANGE", "key offset value"],
  // Hashes
  ["HSET", "key field value [field value ...]"],
  ["HSETNX", "key field value"],
  ["HGET", "key field"],
  ["HMSET", "key field value [field value ...]"],
  ["HMGET", "key field [field ...]"],
  ["HGETALL", "key"],
  ["HDEL", "key field [field ...]"],
  ["HLEN", "key"],
  ["HEXISTS", "key field"],
  ["HKEYS", "key"],
  ["HVALS", "key"],
  ["HINCRBY", "key field increment"],
  ["HINCRBYFLOAT", "key field increment"],
  ["HRANDFIELD", "key [count [WITHVALUES]]"],
  ["HSCAN", "key cursor [MATCH pattern] [COUNT count]"],
  ["HSTRLEN", "key field"],
  // Lists
  ["LPUSH", "key element [element ...]"],
  ["RPUSH", "key element [element ...]"],
  ["LPUSHX", "key element [element ...]"],
  ["RPUSHX", "key element [element ...]"],
  ["LPOP", "key [count]"],
  ["RPOP", "key [count]"],
  ["LLEN", "key"],
  ["LRANGE", "key start stop"],
  ["LINDEX", "key index"],
  ["LSET", "key index element"],
  ["LINSERT", "key BEFORE|AFTER pivot element"],
  ["LREM", "key count element"],
  ["LTRIM", "key start stop"],
  ["RPOPLPUSH", "source destination"],
  ["LMOVE", "source destination LEFT|RIGHT LEFT|RIGHT"],
  ["LPOS", "key element [RANK rank] [COUNT count]"],
  // Sets
  ["SADD", "key member [member ...]"],
  ["SREM", "key member [member ...]"],
  ["SMEMBERS", "key"],
  ["SISMEMBER", "key member"],
  ["SMISMEMBER", "key member [member ...]"],
  ["SCARD", "key"],
  ["SPOP", "key [count]"],
  ["SRANDMEMBER", "key [count]"],
  ["SUNION", "key [key ...]"],
  ["SUNIONSTORE", "destination key [key ...]"],
  ["SINTER", "key [key ...]"],
  ["SINTERSTORE", "destination key [key ...]"],
  ["SINTERCARD", "numkeys key [key ...] [LIMIT limit]"],
  ["SDIFF", "key [key ...]"],
  ["SDIFFSTORE", "destination key [key ...]"],
  ["SMOVE", "source destination member"],
  ["SSCAN", "key cursor [MATCH pattern] [COUNT count]"],
  // Sorted sets
  ["ZADD", "key [NX|XX] [GT|LT] [CH] [INCR] score member [score member ...]"],
  ["ZREM", "key member [member ...]"],
  ["ZSCORE", "key member"],
  ["ZMSCORE", "key member [member ...]"],
  ["ZCARD", "key"],
  ["ZCOUNT", "key min max"],
  ["ZINCRBY", "key increment member"],
  ["ZRANGE", "key start stop [WITHSCORES]"],
  ["ZREVRANGE", "key start stop [WITHSCORES]"],
  ["ZRANGEBYSCORE", "key min max [WITHSCORES] [LIMIT offset count]"],
  ["ZREVRANGEBYSCORE", "key max min [WITHSCORES] [LIMIT offset count]"],
  ["ZRANGEBYLEX", "key min max [LIMIT offset count]"],
  ["ZRANK", "key member"],
  ["ZREVRANK", "key member"],
  ["ZREMRANGEBYRANK", "key start stop"],
  ["ZREMRANGEBYSCORE", "key min max"],
  ["ZPOPMIN", "key [count]"],
  ["ZPOPMAX", "key [count]"],
  ["ZUNIONSTORE", "destination numkeys key [key ...]"],
  ["ZINTERSTORE", "destination numkeys key [key ...]"],
  ["ZDIFFSTORE", "destination numkeys key [key ...]"],
  ["ZSCAN", "key cursor [MATCH pattern] [COUNT count]"],
  // Streams
  ["XADD", "key ID field value [field value ...]"],
  ["XLEN", "key"],
  ["XRANGE", "key start end [COUNT count]"],
  ["XREVRANGE", "key end start [COUNT count]"],
  ["XREAD", "COUNT count STREAMS key [key ...] id [id ...]"],
  ["XDEL", "key ID [ID ...]"],
  ["XTRIM", "key MAXLEN|MINID [~|=] threshold"],
  ["XGROUP", "CREATE|SETID|DESTROY|CREATECONSUMER|DELCONSUMER ..."],
  ["XACK", "key group ID [ID ...]"],
  ["XINFO", "STREAM|GROUPS|CONSUMERS key"],
  // Keys / generic
  ["DEL", "key [key ...]"],
  ["UNLINK", "key [key ...]"],
  ["EXISTS", "key [key ...]"],
  ["TYPE", "key"],
  ["TTL", "key"],
  ["PTTL", "key"],
  ["EXPIRE", "key seconds [NX|XX|GT|LT]"],
  ["PEXPIRE", "key ms [NX|XX|GT|LT]"],
  ["EXPIREAT", "key timestamp"],
  ["PEXPIREAT", "key ms-timestamp"],
  ["PERSIST", "key"],
  ["RENAME", "key newkey"],
  ["RENAMENX", "key newkey"],
  ["COPY", "source destination [DB destination-db] [REPLACE]"],
  ["MOVE", "key db"],
  ["KEYS", "pattern"],
  ["SCAN", "cursor [MATCH pattern] [COUNT count] [TYPE type]"],
  ["RANDOMKEY", ""],
  ["DUMP", "key"],
  ["RESTORE", "key ttl serialized-value"],
  ["OBJECT", "ENCODING|FREQ|IDLETIME|REFCOUNT key"],
  ["SORT", "key [BY pattern] [LIMIT offset count] [GET pattern] [ASC|DESC]"],
  ["TOUCH", "key [key ...]"],
  // Server
  ["SELECT", "index"],
  ["SWAPDB", "index1 index2"],
  ["FLUSHDB", "[ASYNC|SYNC]"],
  ["FLUSHALL", "[ASYNC|SYNC]"],
  ["DBSIZE", ""],
  ["INFO", "[section]"],
  ["CONFIG", "GET|SET|REWRITE|RESETSTAT ..."],
  ["CLIENT", "LIST|GETNAME|SETNAME|KILL|INFO ..."],
  ["MEMORY", "USAGE|STATS|DOCTOR ..."],
  ["COMMAND", "[COUNT|DOCS|INFO|LIST]"],
  ["TIME", ""],
  ["LASTSAVE", ""],
  ["SAVE", ""],
  ["BGSAVE", "[SCHEDULE]"],
  ["BGREWRITEAOF", ""],
  ["SHUTDOWN", "[NOSAVE|SAVE]"],
  ["SLOWLOG", "GET|LEN|RESET ..."],
  ["ACL", "LIST|WHOAMI|CAT|GETUSER|SETUSER ..."],
  ["CLUSTER", "INFO|NODES|SLOTS|SHARDS ..."],
  ["LOLWUT", ""],
  // Connection
  ["PING", "[message]"],
  ["ECHO", "message"],
  ["AUTH", "[username] password"],
  ["HELLO", "[protover]"],
  ["QUIT", ""],
  // Pub/sub
  ["PUBLISH", "channel message"],
  ["PUBSUB", "CHANNELS|NUMSUB|NUMPAT ..."],
  ["SUBSCRIBE", "channel [channel ...]"],
  ["UNSUBSCRIBE", "[channel ...]"],
  ["PSUBSCRIBE", "pattern [pattern ...]"],
  ["PUNSUBSCRIBE", "[pattern ...]"],
  // Scripting
  ["EVAL", "script numkeys [key ...] [arg ...]"],
  ["EVALSHA", "sha1 numkeys [key ...] [arg ...]"],
  ["SCRIPT", "LOAD|EXISTS|FLUSH|KILL ..."],
  ["FUNCTION", "LOAD|DELETE|LIST|DUMP|FLUSH ..."],
  ["FCALL", "function numkeys [key ...] [arg ...]"],
  // Transactions
  ["MULTI", ""],
  ["EXEC", ""],
  ["DISCARD", ""],
  ["WATCH", "key [key ...]"],
  ["UNWATCH", ""],
  // HyperLogLog
  ["PFADD", "key element [element ...]"],
  ["PFCOUNT", "key [key ...]"],
  ["PFMERGE", "destkey key [key ...]"],
  // Geo
  ["GEOADD", "key longitude latitude member [longitude latitude member ...]"],
  ["GEOPOS", "key member [member ...]"],
  ["GEODIST", "key member1 member2 [unit]"],
  ["GEOSEARCH", "key FROMMEMBER member|FROMLONLAT lon lat BYRADIUS radius unit|BYBOX width height unit"],
  ["GEOHASH", "key member [member ...]"],
  // Bitmaps
  ["SETBIT", "key offset value"],
  ["GETBIT", "key offset"],
  ["BITCOUNT", "key [start end [BYTE|BIT]]"],
  ["BITOP", "AND|OR|XOR|NOT destkey key [key ...]"],
  ["BITPOS", "key bit [start end [BYTE|BIT]]"],
  // Monitoring
  ["MONITOR", ""],
  ["LATENCY", "HISTORY|LATEST|RESET ..."],
  ["DEBUG", "OBJECT|SLEEP|JMAP ..."],
  ["WAIT", "numreplicas timeout"],
];

/** Two-word commands whose second word is a sub-command, itself worth completing/highlighting. */
const TWO_WORD_COMMANDS = new Set(["CONFIG", "CLIENT", "MEMORY", "OBJECT", "XINFO", "ACL", "CLUSTER", "COMMAND"]);

const SUB_COMMANDS: Record<string, string[]> = {
  CONFIG: ["GET", "SET", "REWRITE", "RESETSTAT"],
  CLIENT: ["LIST", "GETNAME", "SETNAME", "KILL", "INFO", "ID", "NO-EVICT", "PAUSE", "UNPAUSE"],
  MEMORY: ["USAGE", "STATS", "DOCTOR", "MALLOC-STATS", "PURGE"],
  OBJECT: ["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"],
  XINFO: ["STREAM", "GROUPS", "CONSUMERS", "HELP"],
  ACL: ["LIST", "WHOAMI", "CAT", "GETUSER", "SETUSER", "DELUSER", "USERS", "SAVE", "LOAD"],
  CLUSTER: ["INFO", "NODES", "SLOTS", "SHARDS", "MYID", "KEYSLOT"],
  COMMAND: ["COUNT", "DOCS", "INFO", "LIST", "GETKEYS"],
};

const COMMAND_SET = new Map(REDIS_COMMANDS.map(([name, detail]) => [name.toUpperCase(), detail]));

interface RedisTokenState {
  /** Number of "words" already seen on the current line (comment/blank lines never set this). */
  wordIndex: number;
}

/** The StreamLanguage parser: comments, quoted strings, numbers, and the leading command token(s). */
export const redisParser: StreamParser<RedisTokenState> = {
  name: "redis",

  startState(): RedisTokenState {
    return { wordIndex: 0 };
  },

  token(stream, state) {
    if (stream.sol()) state.wordIndex = 0;

    if (stream.eatSpace()) return null;

    if (state.wordIndex === 0 && stream.match(/^#.*/)) {
      return "comment";
    }

    if (stream.peek() === '"') {
      stream.next();
      let escaped = false;
      while (!stream.eol()) {
        const ch = stream.next();
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') break;
      }
      state.wordIndex++;
      return "string";
    }

    if (stream.peek() === "'") {
      stream.next();
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "'") break;
      }
      state.wordIndex++;
      return "string";
    }

    if (stream.match(/^-?\d+(\.\d+)?/)) {
      state.wordIndex++;
      return "number";
    }

    if (stream.match(/^[^\s"']+/)) {
      const word = stream.current();
      const idx = state.wordIndex;
      state.wordIndex++;
      if (idx === 0 && COMMAND_SET.has(word.toUpperCase())) return "keyword";
      if (idx === 1 && TWO_WORD_COMMANDS.has(stream.string.slice(0, stream.start).trim().toUpperCase())) {
        return "keyword";
      }
      return null;
    }

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: "#" },
  },
};

/**
 * Autocomplete: at the start of a line, Redis commands (and CONFIG/CLIENT/... sub-commands
 * right after the command); anywhere else, key names from the `keys` list passed to `redisLanguage`.
 */
export function redisCompletionSource(keys?: string[]): (context: CompletionContext) => CompletionResult | null {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const beforeCursor = line.text.slice(0, context.pos - line.from);
    const wordMatch = /[^\s"']*$/.exec(beforeCursor);
    const word = wordMatch ? wordMatch[0] : "";
    const from = context.pos - word.length;

    if (word === "" && !context.explicit) return null;

    const wordsBefore = beforeCursor.slice(0, beforeCursor.length - word.length).trim();
    const isFirstWord = wordsBefore === "";

    if (isFirstWord) {
      return {
        from,
        options: REDIS_COMMANDS.map(([name, detail]) => ({ label: name, detail, type: "keyword" })),
        validFor: /^[A-Za-z]*$/,
      };
    }

    const firstWord = wordsBefore.split(/\s+/)[0]?.toUpperCase();
    const isSecondWord = wordsBefore.split(/\s+/).length === 1;
    if (isSecondWord && firstWord && TWO_WORD_COMMANDS.has(firstWord)) {
      const subs = SUB_COMMANDS[firstWord] ?? [];
      return {
        from,
        options: subs.map((name) => ({ label: name, type: "keyword" })),
        validFor: /^[A-Za-z-]*$/,
      };
    }

    if (!keys || keys.length === 0) return null;
    return {
      from,
      options: keys.map((name) => ({ label: name, type: "variable" })),
      validFor: /^[^\s"']*$/,
    };
  };
}

/** CodeMirror extension for the Redis console: highlighting + autocomplete. `keys` feeds key-name completion. */
export function redisLanguage(keys?: string[]): Extension {
  const language = StreamLanguage.define(redisParser);
  return [language, language.data.of({ autocomplete: redisCompletionSource(keys) })];
}
