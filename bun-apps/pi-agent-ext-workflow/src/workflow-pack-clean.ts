/**
 * workflow-pack-clean.ts — inspect/clean/purge a pack's state (decision 06).
 *
 * Three-tier safety:
 *   intermediate 🟢 safe (reproducible; default scope; no confirm needed)
 *   runs 🟡 lossy (history; dry-run by default, --yes to execute)
 *   outputs 🟠 maybe-wanted (dry-run by default, --yes to execute)
 *
 * The journal (`runs/<runId>.json`) is the resume source-of-truth (decision 12);
 * purging intermediate mirrors is always safe (mirror disposable, journal canonical).
 * Retention vocab: `all` (default) | `last-N` (`--keep N`) — minimal per 06.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDirs, packStateRoot } from "./pack-state.js";

export type CleanScope = "intermediate" | "outputs" | "runs" | "all";

export interface PackInspection {
  intermediate: { files: number; bytes: number };
  outputs: { files: number; bytes: number };
  runs: { files: number; bytes: number };
}

export interface CleanReport {
  scope: CleanScope;
  dryRun: boolean;
  removed: number;
}

function dirStats(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) {
      files++;
      bytes += statSync(join(dir, e.name)).size;
    }
  }
  return { files, bytes };
}

export function inspectPack(args: { packDir: string; name: string; repoRoot: string }): PackInspection {
  const { root } = packStateRoot(args);
  ensureStateDirs(root);
  return {
    intermediate: dirStats(join(root, "intermediate")),
    outputs: dirStats(join(root, "outputs")),
    runs: dirStats(join(root, "runs")),
  };
}

export function cleanPack(args: {
  packDir: string;
  name: string;
  repoRoot: string;
  scope?: CleanScope;
  keep?: number;
  dryRun?: boolean;
  yes?: boolean;
}): CleanReport {
  const scope: CleanScope = args.scope ?? "intermediate";
  const { root } = packStateRoot(args);
  ensureStateDirs(root);
  const lossy = scope === "runs" || scope === "outputs" || scope === "all";
  const dryRun = args.dryRun ?? lossy; // lossy tiers default to dry-run
  // An EXPLICIT dry-run always wins — `--dry-run --yes` must never delete.
  // `--yes` only overrides the implicit lossy-tier dry-run default.
  const willExecute = args.dryRun === true ? false : !dryRun || args.yes === true;
  const targets = scope === "all" ? ["intermediate", "outputs", "runs"] : [scope];
  const keep = args.keep;
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 0)) {
    throw new Error(`workflow clean: --keep must be a non-negative integer (got ${keep})`);
  }
  let removed = 0;
  for (const t of targets) {
    const dir = join(root, t);
    if (!existsSync(dir)) continue;
    let entries = readdirSync(dir);
    if (keep !== undefined && keep > 0) {
      // last-N retention: keep the `keep` newest entries (by mtime), delete the rest.
      entries = entries
        .map((e) => ({ name: e, mtime: statSync(join(dir, e)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(keep)
        .map((e) => e.name);
    }
    if (!willExecute) continue; // dry-run: count nothing, remove nothing
    for (const e of entries) rmSync(join(dir, e), { recursive: true, force: true });
    removed += entries.length;
  }
  return { scope, dryRun: !willExecute, removed };
}
