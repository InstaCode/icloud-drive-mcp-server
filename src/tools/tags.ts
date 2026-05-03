/**
 * macOS Finder tag tools.
 */

import {
  assertWriteEnabled,
  NotFoundError,
  readTags,
  relativeToRoot,
  resolveInRoot,
  resolvePathState,
  writeTags,
} from "../icloud.js";

export async function getTags(args: {
  path: string;
}): Promise<{ path: string; tags: string[] }> {
  const abs = resolveInRoot(args.path);
  const state = await resolvePathState(abs);
  if (state.exists === "neither") throw new NotFoundError(args.path, abs);

  const target =
    state.exists === "materialized" ? state.materialized : state.placeholder;
  const tags = await readTags(target);
  return { path: relativeToRoot(target), tags };
}

export async function setTags(args: {
  path: string;
  tags: string[];
}): Promise<{ path: string; tags: string[] }> {
  assertWriteEnabled("set_tags");

  const abs = resolveInRoot(args.path);
  const state = await resolvePathState(abs);
  if (state.exists === "neither") throw new NotFoundError(args.path, abs);

  const target =
    state.exists === "materialized" ? state.materialized : state.placeholder;

  // Normalize: trim, drop empties, dedupe (case-insensitive), preserve order.
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of args.tags) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(t);
  }

  await writeTags(target, normalized);
  return { path: relativeToRoot(target), tags: normalized };
}
