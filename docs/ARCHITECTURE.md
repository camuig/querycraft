# QueryCraft — architecture

A DataGrip-style desktop MySQL client. Cross-platform (macOS, Windows, Linux), fast.

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Shell | Tauri 2 | Native window + system WebView, ~10 MB binary, sub-second startup, a fraction of Electron's memory |
| Backend | Rust, tokio, `mysql_async` | Async driver, streaming result reads, query cancellation via `KILL QUERY` |
| Passwords | `keyring` | System secret storage: Keychain (macOS), Credential Manager (Windows), Secret Service (Linux) |
| Frontend | React 19 + TypeScript + Vite | Fast UI development, familiar stack |
| State | zustand | Minimal boilerplate |
| SQL editor | CodeMirror 6 + `@codemirror/lang-sql` | Lightweight (unlike Monaco), schema-aware autocomplete out of the box |
| Grid | `@tanstack/react-virtual` | Row and column virtualization — hundreds of thousands of cells without jank |
| Panels | `react-resizable-panels` | Resizable panels, DataGrip-style |

## Feature scope

1. **Connections**: create / edit / delete / test a MySQL connection (host, port, user, password, default database, SSL with optional certificate verification). Configs are stored as JSON in the app's data directory; passwords go into the system keyring.
2. **Database explorer** (left panel): connection → databases → tables / views → columns, indexes, foreign keys. Lazy node loading, name filter, context menus for common actions (refresh, copy name, open data/DDL, and similar operations per node kind).
3. **SQL console**: tabs, syntax highlighting, schema-aware autocomplete, running the current statement / selection / whole script (Ctrl/Cmd+Enter, Ctrl/Cmd+Shift+Enter), query cancellation, multiple result sets for multi-statement scripts, execution time, query history. Each console tab keeps its own connection session.
4. **Results grid**: virtualized rows and columns, click-to-sort, DataGrip-style selection — drag, Shift+click and Shift+arrows for ranges, row-number click selects a row, header click selects a column, Ctrl/Cmd+A selects all; arrow/Home/End/PageUp/PageDown/Tab navigation. Copying the selection: Ctrl/Cmd+C copies TSV, a context menu offers CSV and header variants. NULL is rendered with a distinct style.
5. **Table data tab**: open a table → paginated grid with a `WHERE` filter that suggests column names and SQL keywords while typing (Tab/Enter/click to accept, Esc to dismiss, no autocorrect interference), sorting, cell editing, adding and deleting rows with deferred commit (Submit / Revert) applied inside a single transaction. Clipboard paste (Ctrl/Cmd+V or context menu) detects the delimiter (tab, `;`, `,` or `|`), adds missing rows automatically, turns empty values and `NULL` into SQL NULL, and fills a single value across a multi-cell selection.
6. **Table DDL tab**: `SHOW CREATE TABLE` with syntax highlighting.
7. **Export**: results to CSV / JSON / TSV (file or clipboard) and to SQL INSERT statements.
8. **Themes**: system (default, follows the OS setting and switches live), light and dark. A settings dialog (Cmd+, / Ctrl+Alt+S) controls theme, row limit and editor font size; the native menu also exposes the theme and the settings.
9. **Keymap**: shortcuts replicate DataGrip defaults (see the table in the README). `src/lib/keymap.ts` matches `KeyboardEvent.code` per platform; components register handlers on the command bus while active, so a shared key such as Cmd+Enter runs the console in a console tab and submits changes in a data tab. The native menu (`src-tauri/src/menu.rs`) emits an `app-menu` event with the action id, which goes through the same bus.

Out of scope: other databases, ER diagrams, migrations, schema refactoring, schema comparison, SSH tunnels, editing table structure through the UI.

## Session model

As in DataGrip, every console and every data tab owns its **own connection** (`sessionId`), so `USE`, temporary tables and transactions live within that tab. Metadata (explorer, autocomplete) is served from a separate connection pool tied to the connection config.

Query cancellation: the backend remembers the session connection's `CONNECTION_ID()`; `cancel_query` opens a side connection and issues `KILL QUERY <id>`.

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
  sql_split.rs        — splitting SQL into statements (strings, comments, DELIMITER)
  mysql/
    mod.rs            — ConnectionManager: pools, sessions, active queries
    execute.rs        — statement execution, streaming reads up to the row limit
    convert.rs        — mysql Value -> JSON by column type
    schema.rs         — information_schema: databases, tables, columns, indexes, FKs, DDL
src/
  api/types.ts        — contract types (mirrors Rust structs, camelCase)
  api/commands.ts     — typed wrappers over invoke()
  api/mock.ts         — IPC mock for running the UI in a plain browser without Tauri
  store/              — zustand: connections, tabs, explorer, settings, status, toasts
  lib/                — pure functions: sqlSplit, sqlBuilder, changeTracker, pasteParser,
                         whereSuggest, format/export, ids, input props (each with unit tests)
  lib/keymap.ts       — DataGrip-style shortcuts per platform (single source of truth)
  lib/commandBus.ts   — routes keyboard shortcuts and menu events to the active component
  components/
    layout/           — AppShell, Toolbar, StatusBar, TabsBar, TabContent, useAppCommands (global shortcuts + menu)
    explorer/         — database tree: panel, tree model, row, context menu, keyboard nav
    connections/      — connection dialog
    editor/           — SqlEditor (CodeMirror), ConsoleTab, editor commands (duplicate line, …)
    grid/             — DataGrid (virtualized), ResultsPanel, GridCell, selection hook, ExportMenu
    table/            — TableDataTab (view + edit), TableDdlTab, WhereInput
    settings/         — SettingsDialog (theme, row limit, editor font size)
    common/           — Logo, PopupMenu, Toasts, and other shared building blocks
  styles/             — theme.css (theme CSS variables), layout.css, editor.css, grid.css, explorer.css
```

## IPC contract

All commands return `Result<T, String>`; the error string is shown to the user. Rust argument names are snake_case, frontend argument names are camelCase (Tauri converts automatically). The full list of commands lives in `src/api/commands.ts`.

## Tests

- Rust: `cargo test` — SQL splitting, value conversion, connection store.
- TS: `vitest` — sqlSplit (cursor position), sqlBuilder (quoting, UPDATE/INSERT/DELETE generation), changeTracker, pasteParser (delimiter detection, quoted fields), whereSuggest, format/export, keymap, commandBus, editor commands.
