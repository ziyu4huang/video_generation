/**
 * Fact-freshness guard for /wayfind.
 *
 * The grilling discipline gathers facts from the environment (the working tree),
 * but the working tree reflects the *current branch*, which may lag the line of
 * development (origin/<default>). Facts from a stale tree get baked into a map's
 * premise and only surface as wrong at commit time. checkFactFreshness() measures
 * how far HEAD is behind origin/<default> so /wayfind can warn up front.
 *
 * Design: docs/specs/2026-07-21-fact-freshness-guard-design.md
 *  - No network: compares against the LOCAL origin/<default> ref only.
 *  - Graceful: null when not a git repo, origin/<default> is absent, or git is
 *    unavailable — offline / non-git cwd never blocks wayfind.
 */

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";

export interface FactFreshness {
  /** Commits HEAD is behind the base (e.g. origin/main). 0 == current. */
  behind: number;
  /** The base ref compared against, e.g. "origin/main". */
  base: string;
}

type GitSpawnOpts = { cwd: string; encoding: "utf8" };
type SpawnImpl = (cmd: string, args: readonly string[], opts: GitSpawnOpts) => SpawnSyncReturns<string>;

const FALLBACK_BASE = "origin/main";

/** Default spawn — node:child_process. The `as` cast resolves the encoding
 *  overload union to the utf8 string variant. */
const defaultSpawn: SpawnImpl = (cmd, args, opts) => spawnSync(cmd, args, opts) as SpawnSyncReturns<string>;

/** Run git; return the result on exit 0, else null. Null also when spawn itself
 *  throws (git binary missing) — graceful. */
function gitOk(spawnImpl: SpawnImpl, cwd: string, args: readonly string[]): SpawnSyncReturns<string> | null {
  try {
    const r = spawnImpl("git", args, { cwd, encoding: "utf8" });
    return r.status === 0 ? r : null;
  } catch {
    return null;
  }
}

/** Resolve the line-of-development ref: origin/<default> via symbolic-ref,
 *  falling back to origin/main. Null when no usable ref exists. */
function resolveBase(spawnImpl: SpawnImpl, cwd: string): string | null {
  const sym = gitOk(spawnImpl, cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym) {
    const candidate = sym.stdout.trim();
    if (candidate && gitOk(spawnImpl, cwd, ["rev-parse", "--verify", "--quiet", candidate])) {
      return candidate;
    }
  }
  if (gitOk(spawnImpl, cwd, ["rev-parse", "--verify", "--quiet", FALLBACK_BASE])) {
    return FALLBACK_BASE;
  }
  return null;
}

/**
 * How far HEAD is behind the line of development (origin/<default>).
 *
 * No network: compares against the LOCAL origin/<default> ref. The caller
 * surfaces the ref's provenance ("per your last fetch") so a stale ref is
 * visible. Graceful: null when not a git repo, origin/<default> is absent, or
 * git is unavailable.
 *
 * @param opts.spawnImpl inject a spawn fake for tests; defaults to node:child_process.
 */
export function checkFactFreshness(cwd: string, opts: { spawnImpl?: SpawnImpl } = {}): FactFreshness | null {
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  const base = resolveBase(spawnImpl, cwd);
  if (!base) return null;
  const count = gitOk(spawnImpl, cwd, ["rev-list", "--count", `HEAD..${base}`]);
  if (!count) return null;
  const behind = Number.parseInt(count.stdout.trim(), 10);
  return Number.isNaN(behind) ? null : { behind, base };
}

/**
 * Pure: turn the freshness check into a warning string, or null when current.
 * Extracted from the command layer so the message text is unit-testable without
 * a pi ExtensionCommandContext.
 */
export function buildFreshnessWarning(f: FactFreshness | null): string | null {
  if (!f || f.behind <= 0) return null;
  const commits = f.behind === 1 ? "commit" : "commits";
  return (
    `⚠️ Fact freshness: this branch is ${f.behind} ${commits} behind ${f.base} ` +
    `(per your last fetch). Facts gathered now may not reflect ${f.base} — ` +
    "rebase first, or proceed aware."
  );
}
