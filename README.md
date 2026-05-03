# @instacodeio/icloud-drive-mcp-server

MCP server for iCloud Drive on macOS. Lets Claude (or any MCP client) browse, read, search, tag, write, and trash files in your iCloud Drive — with safe defaults and automatic handling of iCloud's `.icloud` placeholder files.

Published under [InstaCode](https://www.npmjs.com/org/instacodeio).

## What it does

Exposes nine tools:

| Tool | Purpose |
|---|---|
| `list_folder` | List entries in a folder under the iCloud root (name, type, size, mtime, placeholder flag) |
| `read_file` | Read a file's contents; auto-materializes `.icloud` placeholders via `brctl download` |
| `write_file` | Create or overwrite a file (write mode only) |
| `delete_file` | Move a file or folder to the macOS Trash, never permanent unlink (write mode only) |
| `download_placeholder` | Trigger `brctl download` for a `.icloud` placeholder without reading it |
| `search_files` | Spotlight (`mdfind`) full-text + filename search, scoped to the iCloud root |
| `recent_files` | Files modified in the last N days, ranked by mtime |
| `get_tags` | Read macOS Finder tags |
| `set_tags` | Write macOS Finder tags (write mode only) |

## Prerequisites

- macOS (uses `brctl`, `mdfind`, `xattr` — these are macOS-only)
- Node.js 18+
- iCloud Drive enabled in System Settings → Apple Account → iCloud → iCloud Drive
- Claude Desktop needs **Full Disk Access** to read iCloud Drive (System Settings → Privacy & Security → Full Disk Access → add Claude)

## Setup

```bash
npm install
npm run build
```

Optionally configure via environment variables:

| Variable | Default | Description |
|---|---|---|
| `ICLOUD_MCP_ROOT` | `~/Library/Mobile Documents/com~apple~CloudDocs/` | Override the iCloud root, or scope the server to a specific subfolder. |
| `ICLOUD_MCP_WRITE` | `false` | Set to `true` (or `1`/`yes`/`on`) to enable `write_file`, `delete_file`, and `set_tags`. |

Path inputs to every tool are resolved relative to `ICLOUD_MCP_ROOT` and validated to stay inside it. Attempts to escape via `..` or absolute paths outside the root are rejected.

## Test it locally

Use the MCP Inspector to poke at the tools without wiring up a client:

```bash
npm run inspect
```

Then in the inspector UI: list tools, call `list_folder`, etc.

## Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`.

If you installed from npm:

```json
{
  "mcpServers": {
    "icloud": {
      "command": "icloud-drive-mcp-server",
      "env": {
        "ICLOUD_MCP_WRITE": "false"
      }
    }
  }
}
```

If you built from source, point at the absolute path of `dist/index.js`:

```json
{
  "mcpServers": {
    "icloud": {
      "command": "node",
      "args": ["/absolute/path/to/icloud-drive-mcp-server/dist/index.js"],
      "env": {
        "ICLOUD_MCP_WRITE": "false"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config.

## Security notes

- **Read-only by default.** Write tools (`write_file`, `delete_file`, `set_tags`) throw a clear error naming `ICLOUD_MCP_WRITE` when the env var is unset/false.
- **Path containment.** Every input path is resolved against `ICLOUD_MCP_ROOT` and rejected if it would escape via `..` or land at an absolute path outside the root.
- **No permanent deletion.** `delete_file` uses the `trash` package, which moves items to the user's Trash. To delete permanently, the user empties Trash themselves.
- **Junk filter on by default.** Listings and search hide Office/LibreOffice lock files, `.DS_Store`, AppleDouble shadow files, Spotlight metadata, and Windows turds. Pass `includeJunk: true` to opt back in.
- **No stdout logging.** The server only writes to `stderr`. `stdout` is reserved for the MCP framing.

## Known limitations (v0.1)

- **Spotlight scope.** `search_files` and `recent_files` rely on `mdfind`, which only returns files Spotlight has indexed. Files added in the last few seconds may not appear yet.
- **Search ranking.** Results are re-sorted by mtime, not relevance — your most recently touched matches float to the top, which may not be the most relevant.
- **Tag colors.** `set_tags` writes labels but does not assign Finder color indices; Finder will pick defaults.
- **Symlinks.** `Desktop` and `Documents` folders are symlinks to iCloud-synced versions; `list_folder` reports them as `symlink` and does not traverse them.
- **No streaming reads.** `read_file` loads the whole file (up to `maxBytes`, default 5 MiB) into memory.

## Roadmap

- [ ] `search_files` ranking knob (`relevance` | `mtime` | `name`)
- [ ] `followSymlinks` option for `list_folder` and search tools
- [ ] Tag color support (preserve existing color indices on rewrite, optional color on set)
- [ ] Streaming `read_file` for large files
- [ ] Optional `move_file` / `copy_file` tools (write mode)
- [ ] `mkdir` tool
- [ ] Make available as a Hosted MCP via Streamable HTTP transport

## Publishing

Releases are published to npm via OIDC trusted publishing — no `NPM_TOKEN` required in CI.

**First publish (one-time, manual):**

The npm trusted-publisher settings page only appears for packages that already exist on npmjs.com. So v0.1.0 must be published manually from a local machine:

```bash
npm login
npm publish --access public
```

> `--provenance` is intentionally omitted here. Provenance attestations require a supported OIDC provider (GitHub Actions, GitLab CI, etc.) and will fail locally with `Automatic provenance generation not supported for provider: null`. The CI workflow below adds `--provenance` automatically.

**After the first publish:**

1. Go to <https://www.npmjs.com/package/@instacodeio/icloud-drive-mcp-server> → Settings → Trusted Publishers
2. Add a publisher with:
   - Repository owner: `InstaCode`
   - Repository name: `icloud-drive-mcp-server`
   - Workflow filename: `publish.yml`

**Subsequent releases (automated):**

```bash
npm version patch   # or minor / major
git push --follow-tags
```

The `Publish to npm` workflow will run on the new `v*` tag, verify the tag matches `package.json`, build, and publish with provenance.

## License

MIT
