/**
 * Repo lint (ADR-0009 anti-reintroduction guard): the upstream superpowers
 * docs namespace is RETIRED — no tracked file (regular or symlink) may exist under
 * the dead upstream paths, and no superpowers artifact may be COMMITTED under
 * `.superpowers/`. Enumeration is git-tracked (`git ls-files`), so local
 * gitignored scratch (e.g. `.superpowers/sdd/` from an SDD run) never
 * false-reds the suite on otherwise-clean main. Runs in the ext's
 * `bun run test` matrix (ci.yml:111) so a committed leak fails CI.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tests/ → ext pkg → bun-apps → repo root (3 levels up)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The retired namespace roots, deliberately KEPT as an anti-reintroduction
 *  tripwire (ADR-0009). The upstream docs path is stored as joined segments
 *  so this guard file never re-introduces the literal dead-path string: that
 *  root is dead on disk (its former {specs,plans} tracked symlinks were
 *  `git rm`'d; the audit docket moved to .planning/audit/), and .superpowers/
 *  was never a commit target. ANY tracked entry under either root — regular
 *  file or reintroduced symlink — fails. */
const RETIRED_DOCS_ROOT = ["docs", "superpowers"].join("/");
const GUARD_ROOTS = [RETIRED_DOCS_ROOT, ".superpowers"];

/** Tracked (committed) files under the guard roots. Local gitignored scratch
 *  (e.g. an untracked `.superpowers/sdd/` dir) never appears here, so it cannot
 *  false-red the guard. */
function trackedFilesUnder(roots: string[]): string[] {
  const out = Bun.spawnSync(["git", "-C", repoRoot, "ls-files", "--", ...roots]);
  const stdout = (out.stdout ?? "").toString().trim();
  return stdout ? stdout.split("\n") : [];
}

test("retired superpowers docs namespace stays retired; no artifacts leak to upstream paths (ADR-0007, ADR-0009)", () => {
  expect(trackedFilesUnder(GUARD_ROOTS)).toEqual([]);
});

test("local UNTRACKED scratch under .superpowers/ does not false-red the guard", () => {
  // An untracked (gitignored) file must never be reported as a leak — this is
  // the regression that made the suite red on otherwise-clean main.
  const scratchDir = join(repoRoot, ".superpowers", "sdd", "plan");
  const scratchFile = join(scratchDir, "scratch-task-brief.md");
  Bun.spawnSync(["mkdir", "-p", scratchDir]);
  Bun.spawnSync(["touch", scratchFile]);
  try {
    expect(trackedFilesUnder(GUARD_ROOTS)).toEqual([]);
  } finally {
    Bun.spawnSync(["rm", "-f", scratchFile]);
    Bun.spawnSync(["rmdir", "-p", scratchDir], { stdout: "ignore", stderr: "ignore" });
  }
});
