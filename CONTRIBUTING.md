# Contributing to QueryCraft

Thanks for your interest in QueryCraft! Bug reports, feature requests and pull requests are all welcome.

## Getting started

Prerequisites: Rust (stable), Node.js 20+, [pnpm](https://pnpm.io) and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm tauri dev          # run the desktop app with hot reload
pnpm dev                # UI only, in a browser with mocked backend (http://localhost:1420)
```

A throwaway MySQL server for development:

```bash
docker run -d --name querycraft-mysql -p 33070:3306 -e MYSQL_ROOT_PASSWORD=secret mysql:8.0
```

## Before you open a pull request

```bash
pnpm typecheck                  # tsc --noEmit
pnpm test                       # frontend unit tests (vitest)
cd src-tauri && cargo test      # backend unit tests
cd src-tauri && cargo clippy -- -D warnings
cd src-tauri && cargo fmt --check
```

Backend integration tests against a live MySQL server are skipped unless `QUERYCRAFT_TEST_DSN` is set:

```bash
cd src-tauri && QUERYCRAFT_TEST_DSN="127.0.0.1:33070:root:secret" cargo test --test live_mysql
```

Please add unit tests for new logic in `src/lib` (pure TypeScript) and in the Rust modules whenever it is
practical. Keep the pull request focused on one change.

## Guidelines

- **Language.** Code, comments, commit messages and UI strings are in English.
- **Keyboard shortcuts** follow DataGrip defaults; see `src/lib/keymap.ts` and the table in the README.
- **Native menu** item ids must match keymap action names (`src-tauri/src/menu.rs`).
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0-beta.4/):
  `type(scope): description`, for example `feat(grid): add fill paste` or `fix(tls): verify server
  certificates`. Use `feat`, `fix`, `docs`, `chore`, `refactor`, `style`, `test`, `ci`, `build` or `perf`;
  keep the subject imperative and under 72 characters, add a body explaining *why* when it is not obvious,
  and mark incompatible changes with a `BREAKING CHANGE:` footer. One logical change per commit.
- **Style.** The repository ships an `.editorconfig`; Rust code is formatted with `rustfmt`.

## Reporting bugs

Open an issue using the *Bug report* template and include your OS, the QueryCraft version, the MySQL
server version and steps to reproduce. Never paste connection passwords or private data into an issue.

## Security issues

Please do not open public issues for security vulnerabilities; see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
