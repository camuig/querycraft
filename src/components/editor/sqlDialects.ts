// Maps a connection's engine to the CodeMirror SQL dialect used for highlighting and completion.
import { MariaSQL, MySQL, PostgreSQL, SQLDialect, SQLite } from "@codemirror/lang-sql";
import type { DbKind } from "../../api/types";

const CLICKHOUSE_KEYWORDS =
  "select from where group by order limit offset having with as on using join left right inner full cross " +
  "array any all asof semi anti global prewhere final sample settings format union intersect except distinct " +
  "and or not in like ilike between is null case when then else end interval cast if exists show create drop " +
  "alter table view materialized dictionary database engine partition primary key ttl codec comment insert into " +
  "values delete update rename attach detach truncate optimize kill query mutation sync async test system " +
  "describe explain grant revoke set use totals rollup cube ordinal desc asc nulls first last collate top " +
  "fetch window over rows range preceding following unbounded current row";

const CLICKHOUSE_TYPES =
  "Int8 Int16 Int32 Int64 Int128 Int256 UInt8 UInt16 UInt32 UInt64 UInt128 UInt256 Float32 Float64 BFloat16 " +
  "Decimal Decimal32 Decimal64 Decimal128 Decimal256 Bool Boolean String FixedString UUID Date Date32 DateTime " +
  "DateTime64 Enum Enum8 Enum16 Array Tuple Map Nullable LowCardinality Nested IPv4 IPv6 JSON Object Variant " +
  "Dynamic Nothing Point Ring Polygon MultiPolygon AggregateFunction SimpleAggregateFunction Interval";

const CLICKHOUSE_BUILTIN =
  "count sum avg min max uniq uniqExact any anyLast argMin argMax groupArray arrayJoin toDate toDateTime " +
  "toString toInt32 toInt64 toUInt32 toUInt64 toFloat64 now today yesterday length lower upper concat " +
  "substring replaceAll splitByChar arrayMap arrayFilter has hasAll hasAny toStartOfDay toStartOfMonth " +
  "toYYYYMM formatDateTime dateDiff parseDateTimeBestEffort ifNull coalesce nullIf multiIf if version " +
  "currentDatabase hostName cityHash64 sipHash64 MD5 rand rowNumberInAllBlocks quantile quantiles median " +
  "MergeTree ReplacingMergeTree SummingMergeTree AggregatingMergeTree CollapsingMergeTree ReplicatedMergeTree " +
  "Memory Log TinyLog Distributed Null Buffer Kafka MaterializedView";

/** ClickHouse: backtick or double-quoted identifiers, backslash escapes, `#` and `--` comments. */
export const ClickHouse = SQLDialect.define({
  keywords: CLICKHOUSE_KEYWORDS,
  types: CLICKHOUSE_TYPES,
  builtin: CLICKHOUSE_BUILTIN,
  backslashEscapes: true,
  hashComments: true,
  identifierQuotes: '`"',
  caseInsensitiveIdentifiers: false,
});

/** Only SQL engines have a CodeMirror SQL dialect; Redis/Valkey use `redisLanguage` instead. */
const DIALECT_BY_KIND: Partial<Record<DbKind, SQLDialect>> = {
  mysql: MySQL,
  mariadb: MariaSQL,
  postgres: PostgreSQL,
  clickhouse: ClickHouse,
  sqlite: SQLite,
};

/** Falls back to MySQL for non-SQL kinds — callers pick the language extension by `queryLanguage` first. */
export function editorDialect(kind: DbKind): SQLDialect {
  return DIALECT_BY_KIND[kind] ?? MySQL;
}
