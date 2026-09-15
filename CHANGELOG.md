# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Native application menu (File, Edit, View, Run, Data, Help) with a Theme submenu and a Settings entry.
- DataGrip-style keymap: refresh, submit/revert, add/delete row, set NULL, paging, tab switching,
  duplicate/delete/move line in the editor, F4 / Cmd+B in the explorer.
- Settings dialog with system, light and dark themes, row limit and editor font size.
- WHERE filter suggestions for column names and SQL keywords.
- Clipboard paste into the table grid with delimiter detection and fill-paste.
- DataGrip-style grid selection: ranges, rows, columns, copy as TSV/CSV with or without headers.

### Fixed

- Column widths in the grid can now be resized by dragging the header edge.
- macOS Dock icon no longer looks oversized next to other applications.
- Text inputs no longer trigger the WebView autocorrect (`account_id` → `Account_id`).

## [0.1.0] - 2026-09-14

### Added

- Initial MVP: connections with keyring-stored passwords, database explorer, SQL console with
  schema-aware autocomplete, virtualized results grid, table data editing with deferred submit,
  DDL view, CSV/JSON/TSV/SQL export.
