/**
 * Wayfind effort lifecycle — status transitions + archival move.
 *
 * Fs-bearing status/move operations on `.planning/<effort>/map.md` and the
 * `.planning/done/` archive. Depends only on the fs-free model (no store edge).
 * (Split out of the former monolithic map.ts.)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CompleteEffortResult,
  doneDir,
  type EffortMeta,
  type EffortStatus,
  effortDir,
  parseMapFrontmatter,
  type SetStatusResult,
  serializeMapFrontmatter,
  today,
} from "./model.js";

/** Read ONLY the effort manifest (`map.md` front-matter) — no `tickets/` scan.
 *  Returns null when there's no map or no front-matter. Cheap enough for the
 *  status overlay to call per-render. */
export function readEffortMeta(cwd: string, effort: string): EffortMeta | null {
  const mapPath = join(effortDir(cwd, effort), "map.md");
  if (!existsSync(mapPath)) return null;
  return parseMapFrontmatter(readFileSync(mapPath, "utf-8")).meta;
}

// ─── lifecycle status (D1: /wayfind done = canonical close) ──────────────────

/** Derive a `created` date from a dated effort slug ("2026-08-03-…" → "2026-08-03"),
 *  else undefined. Used when backfilling front-matter onto legacy maps that never
 *  carried a manifest. */
function deriveCreated(slug: string): string | undefined {
  const m = slug.match(/^(\d{4}-\d{2}-\d{2})-/);
  return m ? (m[1] as string) : undefined;
}

/**
 * Write/overwrite the effort's `status:` front-matter IN PLACE (no move).
 * Preserves any existing manifest fields (created/owner); derives `created` from
 * the slug when the manifest lacks it; always sets `last: today`. Used by the
 * backfill migration and as the status-write half of {@link completeEffort}.
 * No-op-safe: refuses (ok:false) only when there's no map.md.
 */
export function setEffortStatus(cwd: string, effort: string, status: EffortStatus): SetStatusResult {
  const mapPath = join(effortDir(cwd, effort), "map.md");
  if (!existsSync(mapPath)) return { ok: false, reason: `no map at .planning/${effort}/map.md` };
  const raw = readFileSync(mapPath, "utf-8");
  const { meta, body } = parseMapFrontmatter(raw);
  const newMeta: EffortMeta = {
    effort,
    created: meta?.created ?? deriveCreated(effort),
    last: today(),
    status,
    ...(meta?.owner ? { owner: meta.owner } : {}),
  };
  writeFileSync(mapPath, serializeMapFrontmatter(newMeta) + body, "utf-8");
  return { ok: true };
}

/**
 * Canonical close (D1): write `status: complete` to the map's front-matter, then
 * move the effort dir into `.planning/done/`. This is the `/wayfind done`
 * transition — one call files the effort. Refuses (ok:false) when there's no map
 * or the destination already exists (no clobber). Idempotent on the status write;
 * the move is one-shot (a second call refuses on the existing destination).
 */
export function completeEffort(cwd: string, effort: string): CompleteEffortResult {
  const src = effortDir(cwd, effort);
  if (!existsSync(join(src, "map.md"))) {
    return { ok: false, effort, reason: `no map at .planning/${effort}/map.md` };
  }
  const dest = join(doneDir(cwd), effort);
  if (existsSync(dest)) {
    return { ok: false, effort, reason: `destination already exists: .planning/done/${effort}` };
  }
  const s = setEffortStatus(cwd, effort, "complete");
  if (!s.ok) return { ok: false, effort, reason: s.reason };
  mkdirSync(doneDir(cwd), { recursive: true });
  renameSync(src, dest);
  return { ok: true, effort, movedTo: `.planning/done/${effort}` };
}
