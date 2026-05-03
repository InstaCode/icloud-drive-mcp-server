/**
 * Search tools backed by Spotlight (`mdfind`).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isJunkName,
  isPlaceholderName,
  mdfind,
  placeholderToOriginalName,
  relativeToRoot,
} from "../icloud.js";

export interface SearchHit {
  path: string;
  name: string;
  size: number | null;
  mtime: string | null;
  isPlaceholder: boolean;
}

async function statHits(
  absPaths: string[],
  includeJunk: boolean,
): Promise<SearchHit[]> {
  const filtered = includeJunk
    ? absPaths
    : absPaths.filter((abs) => !isJunkName(path.basename(abs)));

  const out: SearchHit[] = [];
  // Stat in parallel batches to avoid running out of FDs on huge result sets.
  const BATCH = 32;
  for (let i = 0; i < filtered.length; i += BATCH) {
    const slice = filtered.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      slice.map(async (abs) => {
        const stat = await fs.lstat(abs);
        const base = path.basename(abs);
        const placeholder = isPlaceholderName(base);
        const displayName = placeholder
          ? placeholderToOriginalName(base)
          : base;
        const hit: SearchHit = {
          path: relativeToRoot(
            placeholder ? path.join(path.dirname(abs), displayName) : abs,
          ),
          name: displayName,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          isPlaceholder: placeholder,
        };
        return hit;
      }),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") out.push(r.value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

export async function searchFiles(args: {
  query: string;
  scope?: string;
  raw?: boolean;
  limit?: number;
  includeJunk?: boolean;
}): Promise<{ query: string; count: number; hits: SearchHit[] }> {
  if (!args.query || args.query.trim().length === 0) {
    throw new Error("search_files requires a non-empty query.");
  }

  const limit = clampLimit(args.limit, 200);
  // Overscan a bit so the post-filter still meets `limit` when junk is hidden.
  const paths = await mdfind(args.query, {
    scope: args.scope,
    raw: args.raw ?? false,
    limit: limit * 2,
  });

  const hits = await statHits(paths, args.includeJunk ?? false);
  // Most-recently-modified first.
  hits.sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""));
  const sliced = hits.slice(0, limit);
  return { query: args.query, count: sliced.length, hits: sliced };
}

// ---------------------------------------------------------------------------
// recent_files
// ---------------------------------------------------------------------------

export async function recentFiles(args: {
  days?: number;
  scope?: string;
  limit?: number;
  includeJunk?: boolean;
}): Promise<{ days: number; count: number; hits: SearchHit[] }> {
  const days = Math.max(1, Math.floor(args.days ?? 7));
  const limit = clampLimit(args.limit, 100);

  // mdfind structured query: kMDItemFSContentChangeDate >= $time.today(-N).
  // Note the negative sign on the offset.
  const query = `kMDItemFSContentChangeDate >= $time.today(-${days})`;

  const paths = await mdfind(query, {
    scope: args.scope,
    raw: true,
    limit: limit * 4, // overscan since we'll re-sort by mtime
  });

  const hits = await statHits(paths, args.includeJunk ?? false);
  hits.sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""));
  return { days, count: Math.min(hits.length, limit), hits: hits.slice(0, limit) };
}

function clampLimit(input: number | undefined, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(input)));
}
