# QueryCraft

Fast, lightweight desktop client for MySQL in the spirit of DataGrip. macOS, Windows and Linux.

Built with Tauri 2 (Rust, `mysql_async`) and React 19 / TypeScript, CodeMirror 6 and a virtualized grid.
The binary is small, it starts in well under a second, and it uses a fraction of the memory of Electron-based tools.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

> QueryCraft is under active development. Expect rough edges and please [report them](https://github.com/camuig/querycraft/issues).

## Features

- **Connections** — create, test and edit MySQL connections; passwords are stored in the system keyring
  (Keychain, Credential Manager, Secret Service), never in plain-text files. SSL connections verify the
  server certificate by default, with an opt-out for self-signed certificates.
- **Database explorer** — databases → tables and views → columns, indexes, foreign keys. Lazy loading,
  filtering, context menus, keyboard navigation.
- **SQL console** — syntax highlighting and schema-aware autocomplete; run the statement under the cursor,
  the selection or the whole script; cancel running queries; multiple result sets with timings.
- **Session per tab** — every console and data tab owns its own connection, so `USE`, transactions and
  temporary tables stay scoped to the tab, exactly like DataGrip.
- **Results grid** — row and column virtualization, sorting, resizable columns, DataGrip-style selection
  (drag, Shift+click, Shift+arrows, row and column selection, select all), copy as TSV/CSV with or without
  headers, export to CSV / JSON / TSV / SQL `INSERT`.
- **Table data editing** — `WHERE` filter with column and keyword suggestions, sorting, pagination, inline
  cell editing, add and delete rows, deferred Submit / Revert applied in a single transaction, SQL preview.
- **Clipboard paste** into the grid: each line becomes a row, missing rows are added, tab / `;` / `,` / `|`
  split values across columns, `NULL` and empty cells become SQL NULL; a single value fills a selected range.
- **DDL view** — `SHOW CREATE TABLE` with highlighting.
- **Themes** — system (follows the OS and switches live), light and dark.
- **Native menu** and **DataGrip keymap** (see below); settings dialog for theme, row limit and editor font size.

## Keyboard shortcuts

Shortcuts follow the DataGrip defaults for each platform.

| Action | macOS | Windows / Linux |
|---|---|---|
| Execute statement / selection | ⌘⏎ | Ctrl+Enter |
| Execute whole script | ⇧⌘⏎ | Ctrl+Shift+Enter |
| Cancel running query | ⌘F2 | Ctrl+F2 |
| New query console | ⌃⇧Q | Ctrl+Shift+Q |
| Refresh explorer / reload page | ⌘R | Ctrl+F5 |
| Submit changes | ⌘⏎ | Ctrl+Enter |
| Revert changes | ⌥⌘Z | Ctrl+Alt+Z |
| Add row | ⌘N | Alt+Insert |
| Delete / restore row | ⌘⌫ | Ctrl+Y |
| Set NULL | ⌥⌘N | Ctrl+Alt+N |
| Next / previous page | ⌥⌘↓ / ⌥⌘↑ | Ctrl+Alt+↓ / Ctrl+Alt+↑ |
| Open table data (explorer) | F4 | F4 |
| Go to DDL (explorer) | ⌘B | Ctrl+B |
| Database explorer | ⌘1 | Alt+1 |
| Close tab | ⌘W | Ctrl+F4 |
| Next / previous tab | ⇧⌘] / ⇧⌘[ | Alt+→ / Alt+← |
| Settings | ⌘, | Ctrl+Alt+S |
| Copy selection (TSV) | ⌘C | Ctrl+C |
| Paste into grid | ⌘V | Ctrl+V |
| Select all cells | ⌘A | Ctrl+A |

In the SQL editor: duplicate line or selection ⌘D / Ctrl+D, delete line ⌘⌫ / Ctrl+Y, move line ⌥⇧↑ / ⌥⇧↓,
toggle line comment ⌘/ / Ctrl+/, find ⌘F / Ctrl+F.

The keymap lives in [`src/lib/keymap.ts`](src/lib/keymap.ts).

## Installation

Download the installer for your platform from the
[Releases](https://github.com/camuig/querycraft/releases) page (`.dmg` for macOS on Apple Silicon and Intel,
`.msi` / `.exe` for Windows, `.AppImage` / `.deb` / `.rpm` for Linux), or build from source as described below.

The binaries are not code-signed yet. On macOS, Gatekeeper reports the app as damaged after the download;
remove the quarantine attribute once and it opens normally:

```bash
xattr -d com.apple.quarantine /Applications/QueryCraft.app
```

On Windows, SmartScreen shows an "unknown publisher" warning: choose *More info* → *Run anyway*.

## Development

Requirements: Rust (stable), Node.js 20+, [pnpm](https://pnpm.io) and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev        # run the desktop app with hot reload
pnpm tauri build      # build the installer for the current OS
pnpm test             # frontend unit tests (vitest)
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome (lint + format check); pnpm lint:fix applies fixes
cd src-tauri && cargo test   # backend unit tests
```

The UI can be developed in a regular browser without Tauri: run `pnpm dev` and open http://localhost:1420 —
IPC commands are served by a mock (`src/api/mock.ts`) with sample connections and data.

Backend integration tests against a live MySQL server are skipped unless the DSN is provided:

```bash
cd src-tauri && QUERYCRAFT_TEST_DSN="127.0.0.1:33070:root:secret" cargo test --test live_mysql
```

A throwaway MySQL server for development:

```bash
docker run -d --name querycraft-mysql -p 33070:3306 -e MYSQL_ROOT_PASSWORD=secret mysql:8.0
```

Application icons are generated from `src/assets/logo-icon.svg` with `pnpm icons` (requires `rsvg-convert`).

## Project layout

```
src-tauri/   Rust backend: Tauri commands, native menu, connection pools, SQL execution, schema metadata
src/         React frontend: api (IPC contract), store (zustand), lib (pure functions + tests), components
docs/        Architecture notes
```

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first.
This project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## License

QueryCraft is released under the [Apache License 2.0](LICENSE).
