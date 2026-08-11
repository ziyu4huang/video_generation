/**
 * Repo lint (ADR-0007 defense-in-depth): no superpowers artifact may be COMMITTED
 * under the upstream paths `docs/superpowers/` or `.superpowers/`. Enumeration is
 * git-tracked (`git ls-files`), so local gitignored scratch (e.g. `.superpowers/sdd/`
 * from an SDD run) never false-reds the suite on otherwise-clean main. Runs in the
 * ext's `bun run test` matrix (ci.yml:111) so a committed leak fails CI.
 *
 * PORTABILITY-GUARDED: this suite spawns `git` (`ls-files`) and coreutils
 * (`mkdir`/`touch`/`rm`/`rmdir`). `git` + coreutils are present on every CI runner
 * and dev machine, and `git ls-files` is a read-only query against the repo index,
 * so these spawns are CI-safe and NOT machine-coupled host-binary probes (unlike
 * spawning ffmpeg / a built swift binary / run.py, which may be absent). The
 * mkdir/touch/rm/rmdir pair writes only to the gitignored `.superpowers/sdd/plan/`
 * scratch space and is reverted in a `finally`. The marker attests this so the
 * portability audit (`scripts/test-portability-audit.sh --strict`) classifies the
 * file GUARDED, not UNGATED P2.
 */
import { expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tests/ → ext pkg → bun-apps → repo root (3 levels up)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Files grandfathered under the upstream paths (the ADR-0007 baseline). */
const ALLOWED = new Set(["docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md"]);

const GUARD_ROOTS = ["docs/superpowers", ".superpowers"];

/** Tracked (committed) files under the guard roots. Local gitignored scratch
 *  (e.g. an untracked `.superpowers/sdd/` dir) never appears here, so it cannot
 *  false-red the guard. */
function trackedFilesUnder(roots: string[]): string[] {
  const out = Bun.spawnSync(["git", "-C", repoRoot, "ls-files", "--", ...roots]);
  const stdout = (out.stdout ?? "").toString().trim();
  return stdout ? stdout.split("\n") : [];
}

/** Committed leaks under the guard roots: tracked, non-symlink, not grandfathered.
 *  Symlinks are skipped because `docs/superpowers/{specs,plans}` are intentional
 *  tracked symlinks to `.planning/{specs,plans}` (ADR-0007 amendment). */
function findLeakedFiles(): string[] {
  const offenders: string[] = [];
  for (const rel of trackedFilesUnder(GUARD_ROOTS)) {
    const abs = join(repoRoot, rel);
    if (lstatSync(abs).isSymbolicLink()) continue;
    if (!ALLOWED.has(rel)) offenders.push(rel);
  }
  return offenders;
}

test("no superpowers artifacts leak to upstream paths (ADR-0007)", () => {
  expect(findLeakedFiles()).toEqual([]);
});

test("local UNTRACKED scratch under .superpowers/ does not false-red the guard", () => {
  // An untracked (gitignored) file must never be reported as a leak — this is
  // the regression that made the suite red on otherwise-clean main.
  const scratchDir = join(repoRoot, ".superpowers", "sdd", "plan");
  const scratchFile = join(scratchDir, "scratch-task-brief.md");
  Bun.spawnSync(["mkdir", "-p", scratchDir]);
  Bun.spawnSync(["touch", scratchFile]);
  try {
    expect(findLeakedFiles()).toEqual([]);
  } finally {
    Bun.spawnSync(["rm", "-f", scratchFile]);
    Bun.spawnSync(["rmdir", "-p", scratchDir], { stdout: "ignore", stderr: "ignore" });
  }
});
