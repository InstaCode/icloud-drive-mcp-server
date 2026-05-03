/**
 * Core iCloud Drive utilities: path resolution & safety, placeholder
 * detection / materialization, mdfind invocation, and macOS tag I/O.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import bplistParser from "bplist-parser";
import bplistCreator from "bplist-creator";

const execFileAsync = promisify(execFile);

const DEFAULT_ROOT = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
);

const TAGS_XATTR = "com.apple.metadata:_kMDItemUserTags";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface Config {
  root: string;
  writeEnabled: boolean;
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const rawRoot = process.env.ICLOUD_MCP_ROOT?.trim();
  let root = rawRoot && rawRoot.length > 0 ? rawRoot : DEFAULT_ROOT;
  if (root.startsWith("~")) {
    root = path.join(os.homedir(), root.slice(1));
  }
  root = path.resolve(root);

  const writeEnabled = parseBool(process.env.ICLOUD_MCP_WRITE);

  cachedConfig = { root, writeEnabled };
  return cachedConfig;
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export class WriteDisabledError extends Error {
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" requires write mode. Set ICLOUD_MCP_WRITE=true to enable write tools.`,
    );
    this.name = "WriteDisabledError";
  }
}

export class PathEscapeError extends Error {
  constructor(input: string) {
    super(
      `Path "${input}" resolves outside ICLOUD_MCP_ROOT and is not allowed.`,
    );
    this.name = "PathEscapeError";
  }
}

export class NotFoundError extends Error {
  readonly input: string;
  readonly resolvedPath: string | null;
  constructor(input: string, resolvedPath: string | null = null) {
    const display =
      resolvedPath && resolvedPath !== input
        ? `${input || "(empty)"} (resolved: ${resolvedPath})`
        : (resolvedPath ?? input) || "(empty)";
    super(`File or folder not found: ${display}`);
    this.name = "NotFoundError";
    this.input = input;
    this.resolvedPath = resolvedPath;
  }
}

export class RootMissingError extends Error {
  constructor(root: string, reason: "missing" | "not-a-directory" | "denied") {
    const detail =
      reason === "missing"
        ? "does not exist"
        : reason === "not-a-directory"
          ? "is not a directory"
          : "could not be read (permission denied — grant Claude Desktop Full Disk Access in System Settings)";
    super(
      `ICLOUD_MCP_ROOT ${detail}: ${root}\n` +
        `Set ICLOUD_MCP_ROOT in your MCP server config to an existing folder, or unset it to use the default iCloud Drive root.`,
    );
    this.name = "RootMissingError";
  }
}

export class PlaceholderTimeoutError extends Error {
  constructor(p: string, timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for iCloud to materialize "${p}".`,
    );
    this.name = "PlaceholderTimeoutError";
  }
}

export function assertWriteEnabled(toolName: string): void {
  if (!getConfig().writeEnabled) throw new WriteDisabledError(toolName);
}

/**
 * Verify that ICLOUD_MCP_ROOT exists, is a directory, and is readable. Throws
 * a RootMissingError with a clear message if not. Call once at startup.
 */
export async function validateRoot(): Promise<void> {
  const { root } = getConfig();
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(root);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new RootMissingError(root, "missing");
    if (e.code === "EACCES" || e.code === "EPERM") {
      throw new RootMissingError(root, "denied");
    }
    throw err;
  }
  if (!stat.isDirectory()) throw new RootMissingError(root, "not-a-directory");

  // Probe readability — readdir to surface permission issues that stat misses.
  try {
    await fs.readdir(root);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EACCES" || e.code === "EPERM") {
      throw new RootMissingError(root, "denied");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Path resolution & safety
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path (relative to the iCloud root, or absolute) and
 * verify it stays within the configured root. Throws PathEscapeError otherwise.
 *
 * Returns the absolute, normalized path. Does not check existence.
 */
export function resolveInRoot(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("Path must be a string.");
  }

  const { root } = getConfig();
  // Treat leading '/' or backslash as relative-to-root, not absolute.
  const stripped = input.replace(/^[/\\]+/, "");
  const joined = path.resolve(root, stripped);

  // Ensure joined is inside root (or is root itself).
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (joined !== root && !joined.startsWith(rootWithSep)) {
    throw new PathEscapeError(input);
  }
  return joined;
}

/** Path relative to the configured root, using forward slashes. */
export function relativeToRoot(absPath: string): string {
  const { root } = getConfig();
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Junk file detection
// ---------------------------------------------------------------------------

/**
 * Patterns matched against the basename. These are files most users don't want
 * cluttering listings or search results: Office/LibreOffice lock files, macOS
 * system metadata, Windows turds left over from cross-platform sync, etc.
 *
 * Hidden by default; pass `includeJunk: true` to list/search tools to keep them.
 */
const JUNK_PATTERNS: RegExp[] = [
  /^~\$/, // Microsoft Office lock files: ~$Report.docx
  /^\.~lock\./, // LibreOffice lock files: .~lock.foo.odt#
  /^\.DS_Store$/, // macOS folder metadata
  /^\.AppleDouble$/, // macOS resource forks on non-HFS volumes
  /^\.AppleDB$/,
  /^\.AppleDesktop$/,
  /^\._/, // macOS resource fork ("AppleDouble") shadow files
  /^\.localized$/, // macOS folder localization stub
  /^\.Spotlight-V100$/,
  /^\.fseventsd$/,
  /^\.Trashes$/,
  /^\.TemporaryItems$/,
  /^\.DocumentRevisions-V100$/,
  /^\.com\.apple\.timemachine\.donotpresent$/,
  /^Thumbs\.db$/i, // Windows
  /^desktop\.ini$/i,
  /^Icon\r?$/, // macOS custom folder icon
];

export function isJunkName(name: string): boolean {
  return JUNK_PATTERNS.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// Placeholder detection / materialization
// ---------------------------------------------------------------------------

/**
 * iCloud placeholders are stored as ".<original-name>.icloud". For example,
 * "report.pdf" becomes ".report.pdf.icloud" on disk when not yet downloaded.
 */
export function isPlaceholderName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".icloud");
}

export function placeholderToOriginalName(name: string): string {
  if (!isPlaceholderName(name)) return name;
  return name.slice(1, -".icloud".length);
}

export function originalToPlaceholderName(name: string): string {
  return `.${name}.icloud`;
}

/**
 * Given a path the user might have given us (either the original name OR the
 * placeholder name), return:
 *   - materialized: the absolute path to the materialized file (may not exist)
 *   - placeholder:  the absolute path to the placeholder (may not exist)
 *   - exists:       which one currently exists on disk, or 'neither'
 */
export interface PathStateResolution {
  materialized: string;
  placeholder: string;
  exists: "materialized" | "placeholder" | "neither";
}

export async function resolvePathState(
  absPath: string,
): Promise<PathStateResolution> {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);

  const originalName = isPlaceholderName(base)
    ? placeholderToOriginalName(base)
    : base;
  const placeholderName = originalToPlaceholderName(originalName);

  const materialized = path.join(dir, originalName);
  const placeholder = path.join(dir, placeholderName);

  const [matExists, phExists] = await Promise.all([
    pathExists(materialized),
    pathExists(placeholder),
  ]);

  let exists: PathStateResolution["exists"] = "neither";
  if (matExists) exists = "materialized";
  else if (phExists) exists = "placeholder";

  return { materialized, placeholder, exists };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Trigger an iCloud download for a placeholder file. Returns the path to the
 * (now-materialized) file. Polls until the placeholder vanishes and the
 * original name appears, or until the timeout elapses.
 */
export async function materialize(
  absPath: string,
  timeoutMs = 30_000,
): Promise<string> {
  const state = await resolvePathState(absPath);

  if (state.exists === "materialized") return state.materialized;
  if (state.exists === "neither") throw new NotFoundError(absPath);

  // Run brctl download. brctl exits quickly; the actual download happens
  // asynchronously via fileproviderd.
  try {
    await execFileAsync("brctl", ["download", state.placeholder]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderr = e.stderr ? `: ${e.stderr.trim()}` : "";
    throw new Error(
      `brctl download failed for "${state.placeholder}"${stderr}`,
    );
  }

  const start = Date.now();
  const pollIntervalMs = 250;
  while (Date.now() - start < timeoutMs) {
    const next = await resolvePathState(absPath);
    if (next.exists === "materialized") return next.materialized;
    await sleep(pollIntervalMs);
  }
  throw new PlaceholderTimeoutError(absPath, timeoutMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// mdfind
// ---------------------------------------------------------------------------

export interface MdfindOptions {
  /** If true, the query is a structured kMDItem query rather than free text. */
  raw?: boolean;
  /** Optional subdirectory (relative to root) to scope the search to. */
  scope?: string;
  /** Cap the number of results returned. */
  limit?: number;
}

/**
 * Run `mdfind`, scoped to the iCloud root (or a sub-scope), and return the
 * absolute paths of matches. Free-text queries are passed via -name when the
 * caller asks; otherwise they're passed straight through.
 */
export async function mdfind(
  query: string,
  opts: MdfindOptions = {},
): Promise<string[]> {
  const { root } = getConfig();
  const scope = opts.scope ? resolveInRoot(opts.scope) : root;

  const args = ["-onlyin", scope];
  if (opts.raw) {
    args.push(query);
  } else {
    // Free-text: mdfind treats positional args as a single query string.
    args.push(query);
  }

  let stdout: string;
  try {
    const result = await execFileAsync("mdfind", args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderr = e.stderr ? `: ${e.stderr.trim()}` : "";
    throw new Error(`mdfind failed${stderr}`);
  }

  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (typeof opts.limit === "number" && opts.limit >= 0) {
    return lines.slice(0, opts.limit);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// macOS tags via xattr / binary plist
// ---------------------------------------------------------------------------

/**
 * Read user tags. macOS encodes tags as a binary plist array of strings, where
 * each string is "<label>" or "<label>\n<colorIndex>". We strip the optional
 * color index and return just the labels.
 */
export async function readTags(absPath: string): Promise<string[]> {
  let buf: Buffer;
  try {
    // -px gives raw binary plist bytes via stdout.
    const result = await execFileAsync("xattr", ["-px", TAGS_XATTR, absPath], {
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
    });
    buf = result.stdout as Buffer;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: Buffer | string;
      code?: string | number;
    };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr instanceof Buffer
          ? e.stderr.toString("utf8")
          : "";
    // No xattr present means no tags. xattr exits 1 with "No such xattr".
    if (/No such xattr/i.test(stderr)) return [];
    if (/No such file/i.test(stderr)) throw new NotFoundError(absPath);
    throw new Error(`xattr read failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }

  // xattr -px outputs a hexdump-style string when piped to a tty; with execFile
  // captured output we get the same hex format. Strip whitespace and decode.
  // Heuristic: if the bytes look like printable hex (only [0-9a-f \n]), decode.
  const text = buf.toString("utf8");
  const hexOnly = /^[0-9a-fA-F\s]*$/.test(text);
  let plistBuf: Buffer;
  if (hexOnly && text.trim().length > 0) {
    plistBuf = Buffer.from(text.replace(/\s+/g, ""), "hex");
  } else {
    plistBuf = buf;
  }

  if (plistBuf.length === 0) return [];

  let parsed: unknown;
  try {
    const result = bplistParser.parseBuffer(plistBuf);
    parsed = result[0];
  } catch (err) {
    throw new Error(
      `Failed to parse tags binary plist for ${absPath}: ${(err as Error).message}`,
    );
  }

  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((v): v is string => typeof v === "string")
    .map((entry) => {
      // Strip optional "\n<colorIndex>" suffix.
      const nl = entry.indexOf("\n");
      return nl >= 0 ? entry.slice(0, nl) : entry;
    });
}

/**
 * Replace the tag set on a file. Pass an empty array to remove all tags.
 */
export async function writeTags(
  absPath: string,
  tags: string[],
): Promise<void> {
  // Verify file exists.
  try {
    await fs.lstat(absPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new NotFoundError(absPath);
    throw err;
  }

  if (tags.length === 0) {
    try {
      await execFileAsync("xattr", ["-d", TAGS_XATTR, absPath]);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      // Removing a missing xattr is fine.
      if (e.stderr && /No such xattr/i.test(e.stderr)) return;
      throw new Error(
        `xattr delete failed${e.stderr ? `: ${e.stderr.trim()}` : ""}`,
      );
    }
    return;
  }

  // Encode as bplist array of strings. We don't preserve color indices.
  const buf: Buffer = bplistCreator(tags);
  const hex = buf.toString("hex");

  try {
    await execFileAsync("xattr", ["-wx", TAGS_XATTR, hex, absPath]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(
      `xattr write failed${e.stderr ? `: ${e.stderr.trim()}` : ""}`,
    );
  }
}
