/**
 * run-test.ts parity — the 12 per-package portable bun tier launchers
 * (bun-apps/<pkg>/run-test.ts), pinned against goldens captured from the LIVE
 * old scripts before the .sh files were deleted on green.
 *
 * Provenance — goldens captured 2026-08-23 from the live old scripts
 * (bun-apps/<pkg>/run-test.sh, the last state before conversion), via:
 *   bash <abs>/bun-apps/<pkg>/run-test.sh --list   → rc 0 (ANSI-exact tier
 *                                                    table, byte-normalized
 *                                                    here: ANSI stripped,
 *                                                    (Ns) timings, /tmp log
 *                                                    paths, inline package
 *                                                    name → <pkg>)
 * Store: bun-apps/tests/goldens/run-test-<pkg>.list (one file per package).
 *
 * MEASURED facts the cases below encode (documented per launcher too):
 *   - All 11 quick/full launchers parse a word that is not one of their tier
 *     names into EXTRA (forwarded to the test runner) — the old ".sh"'s
 *     "unknown tier → exit 2" branch is DEAD CODE from the CLI: a word that
 *     isn't a tier can never land in TIER (measured: `bash run-test.sh bogus`
 *     runs the quick tier with "bogus" forwarded → rc 1 from bun's no-file
 *     filter; `--list bogus` → rc 0, byte-identical to `--list`). The exit-2
 *     contract is REACHABLE only in the effort-stack launcher
 *     (power-tool, via --effort=) and is pinned there.
 *   - `--list` wins over tier/effort validation (`--list bogus` /
 *     `--list --effort=bogus` → rc 0, identical list).
 *   - power-tool: `--effort` with no following value HUNG the old script
 *     (bash `shift 2` with one positional left loops forever); the .ts treats
 *     it as `--effort=` (empty) → the same unknown-effort exit-2 path.
 *
 * PORTABILITY-GUARDED: this test spawns `bun` to run each committed
 * run-test.ts in a child process (asserting its own stdout/stderr/exit code).
 * bun + committed repo scripts are present on every CI runner and dev machine
 * — not a machine-coupled host-binary probe.
 */
import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertParity } from "./helpers/bash-parity.ts"; // bun-apps/tests/helpers

const BUN_APPS = fileURLToPath(new URL("..", import.meta.url));
const GOLDENS = join(BUN_APPS, "tests", "goldens");
const PT = "s2-agent-ext-power-tool";

// tier-set: quick|full × 11 (btw, file2md, flux2, hermes-memory,
// knowledge-card, krea2, ltx, movie-director, obsidian, research-tool, task)
// + quick|medium|high|readonly|full for power-tool (captured per old script).
const QUICK_FULL = [
  "s2-agent-ext-btw",
  "s2-agent-ext-file2md",
  "s2-agent-ext-flux2",
  "s2-agent-ext-hermes-memory",
  "s2-agent-ext-knowledge-card",
  "s2-agent-ext-krea2",
  "s2-agent-ext-ltx",
  "s2-agent-ext-movie-director",
  "s2-agent-ext-obsidian",
  "s2-agent-ext-research-tool",
  "s2-agent-ext-task",
];
const PKGS = [...QUICK_FULL, PT];

function golden(pkg: string): string {
  return readFileSync(join(GOLDENS, `run-test-${pkg}.list`), "utf8");
}

function script(pkg: string): string {
  return join(BUN_APPS, pkg, "run-test.ts");
}

for (const pkg of PKGS) {
  const out = golden(pkg);

  test(`run-test.ts ${pkg} --list / -l (normalized golden, exit 0)`, () => {
  assertParity(script(pkg), [
  { name: `list-${pkg}`, args: ["--list"], expectCode: 0, out, outIs: "normalized", pkgName: pkg },
  { name: `list-short-${pkg}`, args: ["-l"], expectCode: 0, out, outIs: "normalized", pkgName: pkg },
  ]);
  });

  test(`run-test.ts ${pkg} unknown word forwards (not exit 2); --list wins`, () => {
  // A bare word that isn't a tier is EXTRA (forwarded to the test
  // runner) — the old .sh's exit-2 branch is unreachable from the CLI
  // here (measured; see header). The static, deterministic shape of that
  // contract: `--list bogus` exits 0 with the exact list.
  assertParity(script(pkg), [
  {
  name: `list-dominant-${pkg}`,
  args: pkg === PT ? ["--list", "--effort=bogus"] : ["--list", "bogus"],
  expectCode: 0,
  out,
  outIs: "normalized",
  pkgName: pkg,
  },
  ]);
  });
}

test(`run-test.ts ${PT} unknown effort (--effort=: exit 2 + stderr, stdout empty)`, () => {
  assertParity(script(PT), [
  {
  name: "unknown-effort",
  args: ["--effort=bogus"],
  expectCode: 2,
  out: "",
  errIncludes: [
  "unknown effort 'bogus' (want: quick|medium|high|readonly|full)",
  "try: ./run-test.sh --list",
  ],
  },
  ]);
});

// Live quick-tier runs (each runs the real package suite as a child). Gated:
// the CI run of the tests suite is NOT the tier runner — the launcher is the
// script under test. The per-package goldens above are static; these prove the
// step line shape + exit 0 for a real run. file2md is the one package where
// the OLD script no longer passes quick (bare `bun test` → the 12 mock-leak /
// --isolate false failures, 36 fail measured 2026-08-23) — the .ts runs the
// package's CANONICAL `bun run test` (bun test --isolate): 210 pass, and THIS
// case documents the fixed shape.
test.skipIf(process.env.RUN_TEST_LIVE_QUICK !== "1")(
  "run-test.ts live quick tier × 12 (normalized output, exit 0)",
  () => {
  for (const pkg of PKGS) {
  const scriptPath = script(pkg);
  const out =
  pkg === PT
  ? `▶ <pkg> run-test.sh — effort=quick\n✓ unit (quick)  (Ns)\n\n✓ effort=quick passed\n`
  : `▶ <pkg> run-test.sh — tier=quick\n✓ quick  (Ns)\n\n✓ tier=quick passed\n`;
  assertParity(scriptPath, [
  { name: `quick-live-${pkg}`, args: ["quick"], expectCode: 0, out, outIs: "normalized", pkgName: pkg },
  ]);
  }
  },
  400_000, // 12 real suites as children — the 5s default is too small
);
