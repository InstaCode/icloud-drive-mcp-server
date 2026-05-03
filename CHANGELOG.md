# Changelog

All notable changes to `@instacodeio/icloud-drive-mcp-server` are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-02

Initial release.

### Added

- `list_folder` — list entries with type, size, mtime, and `.icloud` placeholder detection.
- `read_file` — read file contents; auto-materializes placeholders via `brctl download` (configurable timeout).
- `write_file` — create or overwrite files. Refuses to overwrite without `overwrite: true`. Write mode required.
- `delete_file` — move file or folder to the macOS Trash via the `trash` package. Never permanent. Write mode required.
- `download_placeholder` — explicitly trigger a `.icloud` materialization without reading.
- `search_files` — Spotlight-backed full-text and filename search, scoped to the iCloud root.
- `recent_files` — files modified in the last N days, ranked by mtime.
- `get_tags` / `set_tags` — read and write macOS Finder tags via xattr + binary plist. Write mode required for `set_tags`.
- Read-only by default; write tools gated by `ICLOUD_MCP_WRITE=true`.
- Path containment: every input path is resolved against `ICLOUD_MCP_ROOT` and rejected if it escapes.
- Startup validation of `ICLOUD_MCP_ROOT` with clear messages for missing / non-directory / permission-denied cases.
- Default junk-file filter on `list_folder` / `search_files` / `recent_files` (Office lock files, `.DS_Store`, AppleDouble files, Spotlight metadata, Windows turds), with `includeJunk: true` opt-out.
- `NotFoundError` reports both the user input and the resolved absolute path.
