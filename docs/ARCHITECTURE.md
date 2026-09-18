# QueryCraft — architecture

A DataGrip-style desktop client for MySQL, MariaDB, PostgreSQL, SQL Server, ClickHouse, SQLite, Redis and Valkey. Cross-platform (macOS, Windows, Linux), fast.

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Shell | Tauri 2 | Native window + system WebView, ~10 MB binary, sub-second startup, a fraction of Electron's memory |
| Backend | Rust, tokio | One `Driver`/`Session` trait pair, engine modules behind it |
| MySQL / MariaDB | `mysql_async` | Async native protocol, streaming result reads, `KILL QUERY` |
| PostgreSQL | `tokio-postgres` + `postgres-native-tls` | Simple-query protocol for text results, cancel tokens |
| SQL Server | `tiberius` (TDS, TLS via rustls — see below) | Schema-qualified tables (`schema.table`), `OFFSET/FETCH` paging, `KILL <spid>` |
| ClickHouse | `reqwest` (HTTP interface) | `JSONCompactEachRowWithNamesAndTypes`, `session_id`, `KILL QUERY` |
| SQLite | `rusqlite` (bundled) | Embedded engine, `sqlite3_interrupt` for cancellation |
| Redis / Valkey | `redis` (RESP, TLS) | Key-value console (one command per line) instead of SQL, `SCAN`-based explorer |
| Passwords | `keyring` | System secret storage: Keychain (macOS), Credential Manager (Windows), Secret Service (Linux) |
| Frontend | React 19 + TypeScript + Vite | Fast UI development, familiar stack |
| State | zustand | Minimal boilerplate |
| SQL editor | CodeMirror 6 + `@codemirror/lang-sql` | Lightweight (unlike Monaco), schema-aware autocomplete out of the box |
| Grid | `@tanstack/react-virtual` | Row and column virtualization — hundreds of thousands of cells without jank |
| Panels | `react-resizable-panels` | Resizable panels, DataGrip-style |

## Feature scope

1. **Connections**: create / edit / delete / test a connection to one of the supported engines (host, port, user, password, default database; a file path for SQLite). The SSH/SSL tab adds TLS with optional certificate verification and a CA certificate file, and an SSH tunnel (password, key file with passphrase, or the OpenSSH agent). Configs are stored as JSON in the app's data directory; the database password and the SSH secret go into the system keyring.
2. **Database explorer** (left panel): connection → databases (PostgreSQL: schemas of the connected database) → tables / views → columns, indexes, foreign keys; for Redis/Valkey, databases 0–15 → keys (loaded with `SCAN`, name filter becomes a server-side `MATCH` pattern). Lazy node loading, name filter, context menus for common actions (refresh, copy name, open data/DDL or open a key's preview command, and similar operations per node kind).
3. **SQL console**: tabs, syntax highlighting, schema-aware autocomplete, running the current statement / selection / whole script (Ctrl/Cmd+Enter, Ctrl/Cmd+Shift+Enter), query cancellation, multiple result sets for multi-statement scripts, execution time, query history. Each console tab keeps its own connection session. Redis/Valkey tabs run the same console component in "redis" mode: one command per line (`src/lib/commandSplit.ts`) with redis-cli quoting and highlighting (`src/components/editor/redisLanguage.ts`) instead of SQL.
4. **Results grid**: virtualized rows and columns, click-to-sort, DataGrip-style selection — drag, Shift+click and Shift+arrows for ranges, row-number click selects a row, header click selects a column, Ctrl/Cmd+A selects all; arrow/Home/End/PageUp/PageDown/Tab navigation. Copying the selection: Ctrl/Cmd+C copies TSV, a context menu offers CSV and header variants. NULL is rendered with a distinct style.
5. **Table data tab**: open a table → paginated grid with a `WHERE` filter that suggests column names and SQL keywords while typing (Tab/Enter/click to accept, Esc to dismiss, no autocorrect interference), sorting, cell editing, adding and deleting rows with deferred commit (Submit / Revert) applied inside a single transaction. Clipboard paste (Ctrl/Cmd+V or context menu) detects the delimiter (tab, `;`, `,` or `|`), adds missing rows automatically, turns empty values and `NULL` into SQL NULL, and fills a single value across a multi-cell selection.
6. **Key data tab** (Redis/Valkey): opened by double-clicking a key in the explorer, the key-value counterpart of the table data tab. Loads the whole value with a type-appropriate command (`src/lib/redisKeyEditor.ts#keyLoadCommand`) into a grid shaped by `TYPE` — `value`, `field`/`value`, `index`/`element` (list; the index is a synthetic read-only column), `member`, `member`/`score`, or read-only stream entries — plus the key's TTL. Editing follows the same deferred-commit pattern as the table data tab (`ChangeTracker`, constructed with no primary key columns since it is only used for its edit-state tracking, never its `buildStatements`), but Submit builds Redis commands instead of SQL (`buildKeyStatements`): renames become a delete-then-set pair, list row deletion uses a sentinel `LSET` per row followed by one `LREM` (so index shifts from the removal never invalidate an in-flight edit), and the whole batch runs atomically via `apply_changes` (`MULTI`/`EXEC`), always led by a `SELECT <db>` statement. The tab also has its own TTL control (`EXPIRE`/`PERSIST`) and a two-click "Delete key" (`DEL`).
7. **Table DDL tab**: `SHOW CREATE TABLE` (PostgreSQL: synthesized from the catalog, SQLite: `sqlite_master.sql`) with syntax highlighting.
8. **Export**: results to CSV / JSON / TSV (file or clipboard) and to SQL INSERT statements.
9. **Themes**: system (default, follows the OS setting and switches live), light and dark. A settings dialog (Cmd+, / Ctrl+Alt+S) controls theme, row limit and editor font size; the native menu also exposes the theme and the settings.
10. **Keymap**: shortcuts replicate DataGrip defaults (see the table in the README). `src/lib/keymap.ts` matches `KeyboardEvent.code` per platform; components register handlers on the command bus while active, so a shared key such as Cmd+Enter runs the console in a console tab and submits changes in a data tab. The native menu (`src-tauri/src/menu.rs`) emits an `app-menu` event with the action id, which goes through the same bus.

Out of scope: ER diagrams, migrations, schema refactoring, schema comparison, SSH tunnels, editing table structure through the UI.

## Engine abstraction

`src-tauri/src/db/mod.rs` defines two traits. A `Driver` is one opened connection config: it answers schema queries from a metadata connection (or pool), opens per-tab `Session`s and cancels their statements. A `Session` runs one statement at a time (`run` returns one `StatementResult` per result set, truncated at the row limit) and applies parameterized changes in a transaction (`apply`). `ConnectionManager` (`db/manager.rs`) and the execution loop (`db/execute.rs`) only talk to these traits; `open_driver` picks the module by `DbKind`.

Everything engine-specific lives under `db/<engine>/`: connecting and TLS, value → JSON conversion, catalog queries mapped onto the shared `TableInfo` / `ColumnInfo` / `IndexInfo` / `ForeignKeyInfo` shapes (the frontend relies on `key == "PRI"` to find primary keys), DDL retrieval and the cancel mechanism (`CancelHandle`). The frontend mirrors this with `src/lib/dialect.ts`: identifier quoting, literal escaping, defaults for the connection form and feature flags such as `supportsEditing`, a `queryLanguage` ("sql" or "redis") that switches the console/editor/explorer between the SQL and key-value UIs, a `rowLimit` ("limit" for a trailing `LIMIT`/`OFFSET`, "fetch" for SQL Server's `OFFSET/FETCH`) that `src/lib/sqlBuilder.ts#buildSelect` uses to generate the right pagination clause, and a `dottedIdentifier` flag (SQL Server only) that makes `quoteIdent`/`qualify` split a `schema.table` name on its last dot and quote each part, plus a CodeMirror dialect per SQL engine (`src/components/editor/sqlDialects.ts`) or the Redis command language (`src/components/editor/redisLanguage.ts`).

Notable mappings:

- PostgreSQL: a connection is bound to one database, so the explorer's "database" level lists **schemas**; sessions run `SET search_path`. Results are read with the simple query protocol (text values typed by the prepared statement's row description); `?` placeholders in generated DML are rewritten to `$n` and parameters are sent as text. The statement splitter understands dollar quoting.
- SQL Server: tables are listed schema-qualified (`schema.table`, e.g. `dbo.Orders`) and quoted as a 3-part identifier (`"db"."schema"."table"`); the catalog splits on the last dot the same way the frontend does. `SELECT` paging has no `LIMIT`, so it uses `OFFSET m ROWS FETCH NEXT n ROWS ONLY`, which requires an `ORDER BY` — pages without an explicit sort fall back to `ORDER BY (SELECT NULL)`. Cancellation kills the session's SPID (`KILL <spid>`). Unlike every other backend, `tiberius` is built with its `rustls` feature rather than `native-tls`: SQL Server always TLS-wraps the login packet regardless of the connection's TLS setting, and on macOS `native-tls` (the system Security framework) cannot complete that handshake at all — connections fail outright, independent of certificate trust settings.
- ClickHouse: every statement is an HTTP POST with `session_id` (keeps `USE`/`SET` per tab) and `query_id` (for `KILL QUERY`); results come as `JSONCompactEachRowWithNamesAndTypes`, truncation uses `max_result_rows` + `result_overflow_mode=break`. No transactions or row-level updates — data tabs are read-only.
- SQLite: one `rusqlite::Connection` per session behind `spawn_blocking`; the explorer lists `PRAGMA database_list`.
- Redis / Valkey: not a SQL engine, so `queryLanguage: "redis"` routes the frontend onto a different set of components instead of the SQL ones — a `StreamLanguage` editor (`redisLanguage.ts`) instead of `@codemirror/lang-sql`, `splitCommands`/`commandAtCursor` (`src/lib/commandSplit.ts`) instead of `sqlSplit.ts`, and a `KeyInfo`/`KeyListing` key catalog (`list_keys`, `SCAN`-based) instead of `TableInfo`. `listTables` returns `[]` and `listDatabases` returns `"0"`..`"15"`; grid editing, DDL and foreign keys do not apply.

## TLS and SSH tunnels

`open_driver` decides where the driver connects (`Endpoint`): the configured host and port, or the local end of an `SshTunnel` (`db/ssh.rs`, built on `russh`). The tunnel binds `127.0.0.1:0` and forwards every accepted connection through a `direct-tcpip` channel of one SSH session, so each tab's session is its own forwarded connection. Host keys are checked against `~/.ssh/known_hosts` (`accept-new` semantics); tests point the check at a temporary file.

TLS always verifies the *configured* host name even through a tunnel: MySQL uses `tls_hostname_override`, PostgreSQL keeps `host` and sets `hostaddr`, ClickHouse keeps the name in the URL and adds a DNS override for it. A CA certificate file is added to the trust store of each connector (`with_root_certs`, `native_tls::Certificate`, `reqwest::Certificate`).

## Session model

As in DataGrip, every console and every data tab owns its **own connection** (`sessionId`), so `USE`, temporary tables and transactions live within that tab. Metadata (explorer, autocomplete) is served from a separate connection (pool) tied to the connection config.

Query cancellation: before a statement starts, the session's `CancelHandle` (MySQL thread id, PostgreSQL cancel token, ClickHouse query id, SQLite interrupt handle) is registered under the `queryId`; `cancel_query` hands it back to the driver.

## Code layout

```
src-tauri/src/
  lib.rs              — Tauri app setup, command and plugin registration
  main.rs             — binary entry point
  commands.rs         — #[tauri::command] wrappers (thin)
  menu.rs             — native application menu; item ids equal keymap action names
  error.rs            — AppError -> String for IPC
  connections.rs       — connection config store (JSON) + keyring
  history.rs          — query history storage
  sql_split.rs        — splitting SQL into statements (strings, comments, DELIMITER, dollar quoting)
  db/
    mod.rs            — DbKind, Driver / Session traits, shared result and metadata types, open_driver
    manager.rs        — ConnectionManager: drivers, sessions, running statements
    execute.rs        — statement loop: split, run, record history; apply_changes
    json.rs           — engine-independent value -> JSON helpers (safe integers, hex)
    schema.rs         — TableInfo / ColumnInfo / IndexInfo / ForeignKeyInfo
    ssh.rs            — SSH tunnel (russh): local listener, direct-tcpip forwarding, known_hosts
    mysql/            — mysql_async: pool + sessions, Value -> JSON by column type, information_schema
    postgres/         — tokio-postgres: simple-query results, catalog queries, synthesized DDL
    clickhouse/       — HTTP interface: JSONCompact parsing, system.* catalog
    sqlite/           — rusqlite behind spawn_blocking, PRAGMA-based catalog
src/
  api/types.ts        — contract types (mirrors Rust structs, camelCase)
  api/commands.ts     — typed wrappers over invoke()
  api/mock.ts         — IPC mock for running the UI in a plain browser without Tauri
  api/mockRedis.ts    — in-memory sample store backing the mock Redis/Valkey connection (list_keys, execute_query, apply_changes)
  store/              — zustand: connections, tabs, explorer, settings, status, toasts
  lib/                — pure functions: sqlSplit, sqlBuilder, changeTracker, pasteParser,
                         whereSuggest, format/export, dialect, ids, input props (each with unit tests)
  lib/keymap.ts       — DataGrip-style shortcuts per platform (single source of truth)
  lib/commandBus.ts   — routes keyboard shortcuts and menu events to the active component
  lib/commandSplit.ts — Redis/Valkey console: one command per non-blank, non-comment line (sqlSplit's counterpart)
  lib/redisCommands.ts — Redis key quoting, the per-`TYPE` preview command, the explorer's key-type monogram
  lib/redisKeyEditor.ts — key data tab: load command per `TYPE`, edit capabilities, ChangeTracker -> Redis commands
  components/
    layout/           — AppShell, Toolbar, StatusBar, TabsBar, TabContent, useAppCommands (global shortcuts + menu)
    explorer/         — database tree: panel, tree model, row, context menu, keyboard nav
    connections/      — connection dialog, EngineSelect (icon + label dropdown/listbox for the Type field)
    editor/           — SqlEditor (CodeMirror), per-engine dialects, redisLanguage (Redis/Valkey), ConsoleTab, editor commands
    grid/             — DataGrid (virtualized), ResultsPanel, GridCell, selection hook, ExportMenu
    table/            — TableDataTab (view + edit), TableDdlTab, WhereInput
    key/              — KeyDataTab (Redis/Valkey key view + edit), the key data tab's counterpart of table/
    settings/         — SettingsDialog (theme, row limit, editor font size)
    common/           — Logo, DbIcon (engine icons), PopupMenu, Toasts, and other shared building blocks
  styles/             — theme.css (theme CSS variables), layout.css, editor.css, grid.css, explorer.css
```

## IPC contract

All commands return `Result<T, String>`; the error string is shown to the user. Rust argument names are snake_case, frontend argument names are camelCase (Tauri converts automatically). The full list of commands lives in `src/api/commands.ts`.

## Tests

- Rust: `cargo test` — SQL splitting, value conversion, connection store, per-engine parsing helpers, and an end-to-end SQLite suite (`tests/sqlite.rs`). Live suites for MySQL, PostgreSQL and ClickHouse run when the matching `QUERYCRAFT_TEST_*_DSN` variable is set (servers in `docker-compose.yml`); `live_tls` and `live_ssh` need the servers from `scripts/tls-servers.sh` and `scripts/ssh-server.sh`.
- TS: `vitest` — sqlSplit (cursor position), sqlBuilder (quoting per dialect including SQL Server's dotted `schema.table` identifiers, UPDATE/INSERT/DELETE generation, `LIMIT`/`OFFSET` vs `OFFSET/FETCH` paging), changeTracker (including `countChanges`), dialect table, connectionForm (per-engine defaults and validation), pasteParser (delimiter detection, quoted fields), whereSuggest, format/export, keymap, commandBus, editor commands, explorer tree model, commandSplit and redisCommands (Redis/Valkey console), redisLanguage (tokenizer and autocomplete), redisKeyEditor (load command per `TYPE`, edit capabilities, statement generation and validation per key type).
