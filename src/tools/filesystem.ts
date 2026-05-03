/**
 * Filesystem-shaped tools: list, read, write, delete, and explicit
 * placeholder download.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import trash from "trash";
import {
  assertWriteEnabled,
  isJunkName,
  isPlaceholderName,
  materialize,
  NotFoundError,
  placeholderToOriginalName,
  relativeToRoot,
  resolveInRoot,
  resolvePathState,
} from "../icloud.js";

export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number | null;
  mtime: string | null;
  isPlaceholder: boolean;
  /** Original (non-placeholder) name when isPlaceholder is true. */
  originalName?: string;
}

// ---------------------------------------------------------------------------
// list_folder
// ---------------------------------------------------------------------------

export async function listFolder(args: {
  path?: string;
  includeHidden?: boolean;
  includeJunk?: boolean;
}): Promise<{ root: string; entries: FsEntry[] }> {
  const target = resolveInRoot(args.path ?? "");
  const includeHidden = args.includeHidden ?? false;
  const includeJunk = args.includeJunk ?? false;

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new NotFoundError(args.path ?? "", target);
    if (e.code === "ENOTDIR") {
      throw new Error(`Not a directory: ${args.path ?? "(root)"} (resolved: ${target})`);
    }
    throw err;
  }

  const entries: FsEntry[] = [];
  for (const d of dirents) {
    const placeholder = isPlaceholderName(d.name);
    if (!includeHidden && d.name.startsWith(".") && !placeholder) continue;
    if (!includeJunk && isJunkName(d.name)) continue;

    const abs = path.join(target, d.name);
    let stat: import("node:fs").Stats | null = null;
    try {
      stat = await fs.lstat(abs);
    } catch {
      // Race: vanished between readdir and lstat. Skip.
      continue;
    }

    let type: FsEntry["type"];
    if (stat.isFile()) type = "file";
    else if (stat.isDirectory()) type = "directory";
    else if (stat.isSymbolicLink()) type = "symlink";
    else type = "other";

    const displayName = placeholder ? placeholderToOriginalName(d.name) : d.name;

    entries.push({
      name: displayName,
      path: relativeToRoot(path.join(target, displayName)),
      type,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      isPlaceholder: placeholder,
      ...(placeholder ? { originalName: displayName } : {}),
    });
  }

  // Sort: directories first, then by name.
  entries.sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === "directory") return -1;
      if (b.type === "directory") return 1;
    }
    return a.name.localeCompare(b.name);
  });

  return { root: relativeToRoot(target) || ".", entries };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const DEFAULT_READ_LIMIT_BYTES = 5 * 1024 * 1024;

export async function readFile(args: {
  path: string;
  encoding?: "utf8" | "base64";
  maxBytes?: number;
  downloadTimeoutMs?: number;
}): Promise<{
  path: string;
  encoding: "utf8" | "base64";
  size: number;
  truncated: boolean;
  content: string;
  wasPlaceholder: boolean;
}> {
  const requested = resolveInRoot(args.path);
  const state = await resolvePathState(requested);

  if (state.exists === "neither") throw new NotFoundError(args.path, requested);

  const wasPlaceholder = state.exists === "placeholder";
  const absPath =
    state.exists === "materialized"
      ? state.materialized
      : await materialize(requested, args.downloadTimeoutMs ?? 30_000);

  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${args.path}`);
  }

  const encoding = args.encoding ?? "utf8";
  const maxBytes = args.maxBytes ?? DEFAULT_READ_LIMIT_BYTES;

  // Stream-read up to maxBytes + 1 to detect truncation cheaply.
  const fh = await fs.open(absPath, "r");
  try {
    const cap = Math.max(0, maxBytes);
    const buf = Buffer.alloc(cap);
    const { bytesRead } = await fh.read(buf, 0, cap, 0);
    const truncated = stat.size > bytesRead;
    const slice = buf.subarray(0, bytesRead);
    const content =
      encoding === "base64" ? slice.toString("base64") : slice.toString("utf8");
    return {
      path: relativeToRoot(absPath),
      encoding,
      size: stat.size,
      truncated,
      content,
      wasPlaceholder,
    };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export async function writeFile(args: {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  overwrite?: boolean;
  createDirs?: boolean;
}): Promise<{ path: string; bytesWritten: number; created: boolean }> {
  assertWriteEnabled("write_file");

  const abs = resolveInRoot(args.path);
  const state = await resolvePathState(abs);

  // If only a placeholder exists, treat it as if the materialized file exists
  // for the purposes of overwrite gating — overwriting it would clobber the
  // user's iCloud content.
  const exists = state.exists !== "neither";
  if (exists && !args.overwrite) {
    throw new Error(
      `Refusing to overwrite existing path "${args.path}". Set overwrite: true to replace.`,
    );
  }

  if (args.createDirs ?? true) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
  }

  const buf =
    (args.encoding ?? "utf8") === "base64"
      ? Buffer.from(args.content, "base64")
      : Buffer.from(args.content, "utf8");

  await fs.writeFile(abs, buf);

  return {
    path: relativeToRoot(abs),
    bytesWritten: buf.byteLength,
    created: !exists,
  };
}

// ---------------------------------------------------------------------------
// delete_file (Trash, never permanent)
// ---------------------------------------------------------------------------

export async function deleteFile(args: {
  path: string;
}): Promise<{ path: string; movedToTrash: true }> {
  assertWriteEnabled("delete_file");

  const abs = resolveInRoot(args.path);
  const state = await resolvePathState(abs);
  if (state.exists === "neither") throw new NotFoundError(args.path, abs);

  const target =
    state.exists === "materialized" ? state.materialized : state.placeholder;

  try {
    await trash(target);
  } catch (err) {
    throw new Error(
      `Failed to move "${args.path}" to Trash: ${(err as Error).message}`,
    );
  }

  return { path: relativeToRoot(target), movedToTrash: true };
}

// ---------------------------------------------------------------------------
// download_placeholder
// ---------------------------------------------------------------------------

export async function downloadPlaceholder(args: {
  path: string;
  timeoutMs?: number;
}): Promise<{
  path: string;
  status: "already-materialized" | "downloaded";
}> {
  const abs = resolveInRoot(args.path);
  const state = await resolvePathState(abs);

  if (state.exists === "neither") throw new NotFoundError(args.path, abs);
  if (state.exists === "materialized") {
    return {
      path: relativeToRoot(state.materialized),
      status: "already-materialized",
    };
  }

  const materialized = await materialize(abs, args.timeoutMs ?? 30_000);
  return { path: relativeToRoot(materialized), status: "downloaded" };
}
