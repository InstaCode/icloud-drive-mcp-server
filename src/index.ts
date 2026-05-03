#!/usr/bin/env node
/**
 * iCloud Drive MCP server (stdio transport).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getConfig, RootMissingError, validateRoot } from "./icloud.js";
import {
  deleteFile,
  downloadPlaceholder,
  listFolder,
  readFile,
  writeFile,
} from "./tools/filesystem.js";
import { recentFiles, searchFiles } from "./tools/search.js";
import { getTags, setTags } from "./tools/tags.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

function ok(payload: unknown): CallToolResult {
  const text = JSON.stringify(payload, null, 2);
  const structured: Record<string, unknown> =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { value: payload };
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

function fail(err: unknown): CallToolResult {
  const e = err as { name?: string; message?: string };
  const message = e?.message ?? String(err);
  const name = e?.name ?? "Error";
  return {
    content: [{ type: "text", text: `${name}: ${message}` }],
    isError: true,
  };
}

function wrap<T>(
  handler: (args: T) => Promise<unknown>,
): (args: T) => Promise<CallToolResult> {
  return async (args: T) => {
    try {
      return ok(await handler(args));
    } catch (err) {
      return fail(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = getConfig();

  // Fail fast with a clear error if the configured root is missing or
  // unreadable, rather than letting every tool call fail mysteriously.
  try {
    await validateRoot();
  } catch (err) {
    if (err instanceof RootMissingError) {
      process.stderr.write(`icloud-mcp startup error:\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const server = new McpServer(
    { name: "icloud-mcp", version: "0.1.0" },
    {
      instructions:
        `Tools for browsing, searching, and tagging files in iCloud Drive on macOS.\n` +
        `Root: ${config.root}\n` +
        `Write mode: ${config.writeEnabled ? "ENABLED" : "disabled (read-only)"}.`,
    },
  );

  // -------------------------------------------------------------------------
  // Filesystem
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_folder",
    {
      title: "List folder",
      description:
        "List entries in a folder under the iCloud root. Shows name, type, size, mtime, and whether each entry is a not-yet-downloaded .icloud placeholder.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Folder path relative to ICLOUD_MCP_ROOT. Defaults to the root itself.",
          ),
        includeHidden: z
          .boolean()
          .optional()
          .describe("Include dotfiles (other than .icloud placeholders)."),
        includeJunk: z
          .boolean()
          .optional()
          .describe(
            "Include OS/Office cruft (~$lockfile, .DS_Store, Thumbs.db, etc). Hidden by default.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ path, includeHidden, includeJunk }) =>
      listFolder({ path, includeHidden, includeJunk }),
    ),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a file's contents. If it is a .icloud placeholder, triggers `brctl download` and waits for materialization (up to 30s by default).",
      inputSchema: {
        path: z.string().describe("File path relative to ICLOUD_MCP_ROOT."),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("How to encode the response. Defaults to utf8."),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Truncate after this many bytes. Default 5 MiB."),
        downloadTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Materialization wait timeout in ms. Default 30000."),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(readFile),
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create or overwrite a file inside the iCloud root. Requires overwrite=true to replace an existing file. Requires ICLOUD_MCP_WRITE=true.",
      inputSchema: {
        path: z.string().describe("File path relative to ICLOUD_MCP_ROOT."),
        content: z.string().describe("File contents (utf8 or base64)."),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("Encoding of `content`. Defaults to utf8."),
        overwrite: z
          .boolean()
          .optional()
          .describe("Allow overwriting an existing file."),
        createDirs: z
          .boolean()
          .optional()
          .describe("Create parent directories if missing. Default true."),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    wrap(writeFile),
  );

  server.registerTool(
    "delete_file",
    {
      title: "Move file to Trash",
      description:
        "Move a file or folder to the macOS Trash (never permanent unlink). Requires ICLOUD_MCP_WRITE=true.",
      inputSchema: {
        path: z.string().describe("Path relative to ICLOUD_MCP_ROOT."),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    wrap(deleteFile),
  );

  server.registerTool(
    "download_placeholder",
    {
      title: "Materialize iCloud placeholder",
      description:
        "Trigger `brctl download` for a .icloud placeholder file and wait for it to materialize, without reading its contents.",
      inputSchema: {
        path: z.string().describe("Path relative to ICLOUD_MCP_ROOT."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Wait timeout in ms. Default 30000."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    wrap(downloadPlaceholder),
  );

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  server.registerTool(
    "search_files",
    {
      title: "Search files (Spotlight)",
      description:
        "Full-text + filename search via `mdfind`, scoped to ICLOUD_MCP_ROOT (or a sub-scope). Pass raw=true to use a structured Spotlight query string.",
      inputSchema: {
        query: z.string().describe("Spotlight query."),
        scope: z
          .string()
          .optional()
          .describe(
            "Subdirectory under the root to scope to. Default: whole root.",
          ),
        raw: z
          .boolean()
          .optional()
          .describe(
            "Treat `query` as a structured kMDItem expression (advanced).",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results. Default 200, capped at 1000."),
        includeJunk: z
          .boolean()
          .optional()
          .describe(
            "Include OS/Office cruft in results. Hidden by default.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(searchFiles),
  );

  server.registerTool(
    "recent_files",
    {
      title: "Recently modified files",
      description:
        "Files modified in the last N days (default 7), sorted by mtime descending. Uses Spotlight's content-change-date predicate.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Lookback window in days. Default 7."),
        scope: z
          .string()
          .optional()
          .describe("Subdirectory to scope to. Default: whole root."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results. Default 100, capped at 1000."),
        includeJunk: z
          .boolean()
          .optional()
          .describe(
            "Include OS/Office cruft in results. Hidden by default.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(recentFiles),
  );

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_tags",
    {
      title: "Get Finder tags",
      description: "Read macOS Finder tags from a file or folder.",
      inputSchema: {
        path: z.string().describe("Path relative to ICLOUD_MCP_ROOT."),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(getTags),
  );

  server.registerTool(
    "set_tags",
    {
      title: "Set Finder tags",
      description:
        "Replace the macOS Finder tag set on a file or folder. Pass an empty array to clear all tags. Requires ICLOUD_MCP_WRITE=true.",
      inputSchema: {
        path: z.string().describe("Path relative to ICLOUD_MCP_ROOT."),
        tags: z.array(z.string()).describe("Tag labels."),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    wrap(setTags),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Note: do NOT log to stdout — the stdio transport uses it for the protocol.
  process.stderr.write(
    `icloud-mcp ready. root=${config.root} write=${config.writeEnabled}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`icloud-mcp fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
