/**
 * ci-local.ts parity — the portable Bun twin of scripts/ci-local.sh (the local
 * executor of the CI `tests` matrix + `regression-gates` job, parsed live from
 * .github/workflows/ci.yml.disabled). The old script is RETIRED on green; this
 * test pins the static surface its consumers rely on:
 *   - `--tsv` (two-field matrix form): consumed by
 *     bun-apps/tests/ci-workflow-references.test.ts (the matrix↔tree guard) —
 *     that guard shells out to it, so the output must stay decoration-free:
 *     no colors, no headers, no totals, exactly two fields per line.
 *   - `--gates --tsv` (three-field form) + `--gates --list`: the pre-push-hook
 *     contract (the hook runs `bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --gates`; the exit-code
 *     contract 0/4/1 is documented in .githooks/pre-push).
 *   - `--list`, `-h`/`--help`: the eyeball surfaces.
 *   - usage errors: `--only` w/o value, unknown flag, `--only <pkg>` that is
 *     not in the matrix, `--gates` + `--only` — all exit 2 (D4 exit-code law).
 *
 * THE FULL MATRIX RUN is NOT a unit golden (it runs 31 real package suites) —
 * it is the integration A/B, and the static surfaces above are the contract.
 *
 * Provenance — goldens captured 2026-08-23 from the LIVE old script
 * (bun-apps/s2-agent-ext-devops/scripts/ci-local.sh, still alive at 91bcb38e,
 * the base of this task):
 *   bash <abs>/scripts/ci-local.sh --list        → rc 0 (32 rows, dirs all ok)
 *   bash <abs>/scripts/ci-local.sh --tsv         → rc 0 (32 tab-separated rows)
 *   bash <abs>/scripts/ci-local.sh --gates --tsv → rc 0 (25 three-field rows)
 *   bash <abs>/scripts/ci-local.sh --gates --list→ rc 0 (gates table)
 *   bash <abs>/scripts/ci-local.sh -h            → rc 0 (the 58-line header)
 *   bash <abs>/scripts/ci-local.sh --only        → rc 2 "--only needs a value"
 *   bash <abs>/scripts/ci-local.sh --only bogus --list → rc 2 (stderr die)
 *   bash <abs>/scripts/ci-local.sh --gates --only x   → rc 2 (stdout message)
 *   bash <abs>/scripts/ci-local.sh --bogus       → rc 2 "unknown flag: --bogus"
 *
 *   BEHIND THE CAPTURE — the PyYAML split (measured): this machine's `python3`
 *   (3.14.7) has NO PyYAML, so the old script's matrix parse runs its FALLBACK
 *   line parser (stderr: "PyYAML unavailable — using the fallback line parser")
 *   and `--gates` aborts with exit 4 ("PyYAML required (pip install pyyaml)") —
 *   exactly the environment hole .githooks/pre-push's 4→warn degradation
 *   exists for. The goldens above were therefore captured TWICE: once on the
 *   bare machine (fallback path) and once with a PyYAML-capable python3 on
 *   PATH (a uv venv: python3.12.11 + pyyaml 6.0.3). The two matrix parses are
 *   byte-identical (modulo trailing newline) — the fallback row set matches
 *   the YAML parse row-for-row on the current workflow. The `--gates` goldens
 *   are the PyYAML-true ones (the only ordering that produces output at all).
 *
 *   The .ts parses with Bun's built-in YAML — the authoritative path, no
 *   python3 anywhere, so by construction it can never hit the exit-4 hole.
 *   Measured divergences (both machine-environment, both strictly better):
 *     (a) the "PyYAML unavailable — using the fallback line parser" stderr
 *         line is gone — the .ts has no fallback because it needs none;
 *     (b) `--gates` works unconditionally where the old script exited 4 on
 *         this machine. `bun test`'s CI run therefore compares the .ts against
 *         the PyYAML-true bash outputs, not the dead-ringer exit-4 path.
 *
 *   The matrix is parsed as a BLOCK from the workflow (see src/ci-matrix.ts:18,
 *   which states the same matrix is parsed there) — this port does NOT reuse
 *   src/ci-matrix.ts's parseCiMatrix: that parser deliberately DEGRADES to {}
 *   (readCiMatrix must stay usable on a machine with no workflow) and drops
 *   row ORDER, while ci-local must fail loudly (an empty parse must never read
 *   as "everything passed" — the .sh's THE ONE DESIGN RULE) and keep order.
 *   The script therefore keeps its own workflow-path constant (the same value
 *   as ci-matrix.ts's CI_WORKFLOW_PATH, deliberately duplicated so the script
 *   stays standalone); the parsing logic is a semantic port of the .sh's
 *   python snippet, with Bun.YAML in place of PyYAML.
 *
 *   HELP TEXT — the one place the twin's stdout differs from the old script:
 *   `-h` in the .sh printed file lines 2-60 (its own header) via `sed`, and a
 *   header's job is to document the file it lives in. The .ts header is the
 *   same document with the two naming substitutions already applied:
 *     "# ci-local.sh — run…"                      → "# ci-local.ts — run…"
 *     "bash scripts/ci-local.sh …"                → "bun …scripts/ci-local.ts …"
 *   Everything else is byte-identical, and the golden below is DERIVED from
 *   the old script's captured header by those same substitutions, so a doc
 *   drift away from the ported text fails. One deliberate refresh over the
 *   two substitutions (w3 final review): the non-coverage line
 *   "(bun-apps/s2-agent/run-test.sh high + readonly)" named a file Task 8
 *   deleted — it now reads "(bun-apps/s2-agent-ext-devops/scripts/run-test.ts
 *   full — the high/readonly tiers are GONE)" in BOTH the script and the
 *   golden, per run-test.ts's own header ("The `high` and `readonly` tiers are
 *   GONE").
 *
 *   Color note: all captured outputs are NON-TTY (spawn pipes) — the .sh
 *   disables colors when stdout isn't a TTY ([ -t 1 ]), so these goldens
 *   contain no ANSI escapes and match the .ts's plain mode.
 */
import { test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertParity } from "../../tests/helpers/bash-parity.ts"; // bun-apps/tests/helpers (two levels up: pkg/tests -> bun-apps)

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const CI_LOCAL = join(PKG_DIR, "scripts", "ci-local.ts");

// ── goldens (verbatim from the live captures above) ─────────────────────────

// `--tsv`: the machine-readable face the ci-workflow-references guard reads
// through this parser. Two fields only, no decoration — that IS the contract.
const MATRIX_TSV_GOLDEN = `s2-agent\tbun test && bun run typecheck
s2-agent-ext-flux2\tbun test
s2-agent-ext-krea2\tbun test
s2-agent-ext-ltx\tbun test
s2-agent-ext-movie-director\tbun test
s2-agent-ext-power-tool\tbun test
s2-agent-ext-hyperframes\tbun run test
s2-agent-ext-btw\tbun test
s2-agent-ext-task\tbun test
s2-agent-ext-research-tool\tbun test
s2-agent-ext-zai-mcp\tbun test
s2-agent-ext-tool-gate\tbun test && bun run qa
s2-agent-ext-archify\tbun test --isolate
perf-harness\tbun test
zcode-generate-slide-video\tbun run test && bun run typecheck
s2-agent-ext-wayfind\tbun run test
s2-agent-ext-superpowers\tbun run test
s2-agent-ext-sv-analyzer\tbun test
s2-agent-ext-web-access\tbun test
s2-agent-core-interface\tbun test
s2-agent-core-runtime\tbun test
s2-agent-ext-devops\tbun test
s2-agent-ext-prompt-history\tbun test
s2-agent-ext-compact\tbun test
s2-agent-ext-file2md\tbun test --isolate
gui-movie-director\tbun run test && bun run typecheck
s2-agent-ext-knowledge-card\tbun test __tests__/e2e-orchestration.test.ts --isolate && bun test __tests__/allowlists.test.mjs __tests__/ingest.test.ts __tests__/merge.test.ts __tests__/emit.test.ts __tests__/similarity.test.ts __tests__/retrieve.test.ts __tests__/pi-knowledge-card.test.ts __tests__/blend.test.ts && bun test __tests__/toolWiring.test.mjs
s2-agent-ext-obsidian\tbun test extensions/__tests__/
s2-agent-ext-ultracode\tbun run test
s2-agent-ext-webui\tbun test
s2-agent-ext-subagent\tbun run test
s2-agent-ext-hermes-memory\tbun test
`;

const MATRIX_LIST_GOLDEN = `ci-local --list (parsed from .github/workflows/ci.yml.disabled · tests matrix)
32 entries; each runs in its directory with CI=true

#   DIR  PACKAGE                          COMMAND
--- ---- -------------------------------- --------
1   ok   s2-agent                         bun test && bun run typecheck
2   ok   s2-agent-ext-flux2               bun test
3   ok   s2-agent-ext-krea2               bun test
4   ok   s2-agent-ext-ltx                 bun test
5   ok   s2-agent-ext-movie-director      bun test
6   ok   s2-agent-ext-power-tool          bun test
7   ok   s2-agent-ext-hyperframes         bun run test
8   ok   s2-agent-ext-btw                 bun test
9   ok   s2-agent-ext-task                bun test
10  ok   s2-agent-ext-research-tool       bun test
11  ok   s2-agent-ext-zai-mcp             bun test
12  ok   s2-agent-ext-tool-gate           bun test && bun run qa
13  ok   s2-agent-ext-archify             bun test --isolate
14  ok   perf-harness                     bun test
15  ok   zcode-generate-slide-video       bun run test && bun run typecheck
16  ok   s2-agent-ext-wayfind             bun run test
17  ok   s2-agent-ext-superpowers         bun run test
18  ok   s2-agent-ext-sv-analyzer         bun test
19  ok   s2-agent-ext-web-access          bun test
20  ok   s2-agent-core-interface          bun test
21  ok   s2-agent-core-runtime            bun test
22  ok   s2-agent-ext-devops              bun test
23  ok   s2-agent-ext-prompt-history      bun test
24  ok   s2-agent-ext-compact             bun test
25  ok   s2-agent-ext-file2md             bun test --isolate
26  ok   gui-movie-director               bun run test && bun run typecheck
27  ok   s2-agent-ext-knowledge-card      bun test __tests__/e2e-orchestration.test.ts --isolate && bun test __tests__/allowlists.test.mjs __tests__/ingest.test.ts __tests__/merge.test.ts __tests__/emit.test.ts __tests__/similarity.test.ts __tests__/retrieve.test.ts __tests__/pi-knowledge-card.test.ts __tests__/blend.test.ts && bun test __tests__/toolWiring.test.mjs
28  ok   s2-agent-ext-obsidian            bun test extensions/__tests__/
29  ok   s2-agent-ext-ultracode           bun run test
30  ok   s2-agent-ext-webui               bun test
31  ok   s2-agent-ext-subagent            bun run test
32  ok   s2-agent-ext-hermes-memory       bun test

Not covered by this script: extension-contract, deploy-verify, compile-verify,
clean-launch-self-heal, determinism-spotcheck. Run regression-gates with --gates.`;

// `--gates --tsv`: the three-field form (name / working-directory / run).
// Rows re-captured 2026-08-23 — the no-bash-skills guard became gate #15.
// This is a workflow fact, not a .sh output change: the .sh is gone (D3) and
// the rows track the workflow's live regression-gates job.
const GATES_TSV_GOLDEN = `File-size guard (2 MB, blocks)	.	bash scripts/ci-file-size-guard.sh
Lockfile duplicate-version guard (blocks)	.	bash scripts/check-lockfile-duplicate-versions.sh
Lockfile freshness guard (package.json vs bun.lock, blocks)	.	bash scripts/check-lockfile-freshness.sh
Dependency-direction guard (ADR-monorepo-0001, blocks)	bun-apps	bun run test:deps
Registry base-set scanner guard (blocks)	bun-apps	bun run test:base-set
ADR identity + citation guard (blocks)	bun-apps	bun run test:adr
Cross-skill reference guard (blocks)	bun-apps	bun run test:skills-ref
Skill frontmatter guard (blocks)	bun-apps	bun run test:skill-frontmatter
Dead-export guard (blocks)	bun-apps	bun run test:dead-export
Cross-extension seam-contract guard (status widget, blocks)	bun-apps	bun run test:seam
Cross-extension routing-contract guard (bootstrap ↔ wayfind, blocks)	bun-apps	bun run test:routing
Cross-extension isolation-contract guard (portable base set, blocks)	bun-apps	bun run test:isolation
Config-field parity guard (hermes loadConfig, blocks)	bun-apps	bun run test:config-parity
Test-portability audit regression test	bun-apps	bun run test:portability-audit
CI-workflow reference guard (matrix ↔ tree, blocks)	bun-apps	bun run test:ci-workflow
No-bash-skills guard (deleted launchers, blocks)	bun-apps	bun run test:no-bash-skills
Package-script runnability guard (bare binaries, blocks)	bun-apps	bun run test:scripts
Workspace dist-freshness guard (blocks)	bun-apps	bun run test:dist
Deploy-sh L1 e2e (deployed binary runs its extensions, blocks)	.	bash scripts/check-deploy-e2e.sh
Extension-entry typecheck coverage (blocks)	bun-apps	bun run test:ext-entry
Extension-entry typecheck (executor, blocks)	bun-apps	bun run typecheck:ext
Lint-executor coverage (blocks)	bun-apps	bun run test:lint-coverage
Test-portability audit (--strict, blocks)	.	bash scripts/test-portability-audit.sh --strict
Test-determinism audit (D2 --strict, blocks)	.	bash scripts/test-determinism-audit.sh --strict
PR-finish decision tests (devops-merge-pr-after-ci)	bun-apps/s2-agent-ext-devops	bun test tests/merge-pr-after-ci-cli.test.ts
Schema-cost regression (warns >5%, not a block)	.	bun scripts/check-schema-cost.ts
Declared-imports audit (warn-only v1)	.	node scripts/check-declared-imports.mjs
`;

const GATES_LIST_GOLDEN = `ci-local --list (parsed from .github/workflows/ci.yml.disabled · regression-gates job)
27 entries; each runs in its directory with CI=true

#   DIR  GATE                             COMMAND
--- ---- -------------------------------- --------
1   ok   File-size guard (2 MB, blocks)   bash scripts/ci-file-size-guard.sh
2   ok   Lockfile duplicate-version guard bash scripts/check-lockfile-duplicate-versions.sh
3   ok   Lockfile freshness guard (packag bash scripts/check-lockfile-freshness.sh
4   ok   Dependency-direction guard (ADR- bun run test:deps
5   ok   Registry base-set scanner guard  bun run test:base-set
6   ok   ADR identity + citation guard (b bun run test:adr
7   ok   Cross-skill reference guard (blo bun run test:skills-ref
8   ok   Skill frontmatter guard (blocks) bun run test:skill-frontmatter
9   ok   Dead-export guard (blocks)       bun run test:dead-export
10  ok   Cross-extension seam-contract gu bun run test:seam
11  ok   Cross-extension routing-contract bun run test:routing
12  ok   Cross-extension isolation-contra bun run test:isolation
13  ok   Config-field parity guard (herme bun run test:config-parity
14  ok   Test-portability audit regressio bun run test:portability-audit
15  ok   CI-workflow reference guard (mat bun run test:ci-workflow
16  ok   No-bash-skills guard (deleted la bun run test:no-bash-skills
17  ok   Package-script runnability guard bun run test:scripts
18  ok   Workspace dist-freshness guard ( bun run test:dist
19  ok   Deploy-sh L1 e2e (deployed binar bash scripts/check-deploy-e2e.sh
20  ok   Extension-entry typecheck covera bun run test:ext-entry
21  ok   Extension-entry typecheck (execu bun run typecheck:ext
22  ok   Lint-executor coverage (blocks)  bun run test:lint-coverage
23  ok   Test-portability audit (--strict bash scripts/test-portability-audit.sh --strict
24  ok   Test-determinism audit (D2 --str bash scripts/test-determinism-audit.sh --strict
25  ok   PR-finish decision tests (devops bun test tests/merge-pr-after-ci-cli.test.ts
26  ok   Schema-cost regression (warns >5 bun scripts/check-schema-cost.ts
27  ok   Declared-imports audit (warn-onl node scripts/check-declared-imports.mjs

This is the regression-gates job. Run the tests matrix with no --gates flag.`;

const ONLY_LIST_GOLDEN = `ci-local --list (parsed from .github/workflows/ci.yml.disabled · tests matrix)
1 entry; each runs in its directory with CI=true

#   DIR  PACKAGE                          COMMAND
--- ---- -------------------------------- --------
1   ok   s2-agent                         bun test && bun run typecheck

Not covered by this script: extension-contract, deploy-verify, compile-verify,
clean-launch-self-heal, determinism-spotcheck. Run regression-gates with --gates.`;

// NOTE: the golden-vs-workflow cross-check (every matrix row matches a raw
// YAML parse) lives in bun-apps/tests/ci-workflow-references.test.ts, which
// reads the matrix THROUGH this same --tsv output. The parity test pins the
// output; that guard pins the agreement.

test("ci-local.ts --tsv (two-field matrix, exit 0, decoration-free)", () => {
  assertParity(CI_LOCAL, [{ name: "tsv", args: ["--tsv"], expectCode: 0, out: MATRIX_TSV_GOLDEN }]);
});

test("ci-local.ts --list (32-row table, exit 0)", () => {
  assertParity(CI_LOCAL, [{ name: "list", args: ["--list"], expectCode: 0, out: MATRIX_LIST_GOLDEN }]);
});

test("ci-local.ts --only filter previews just that subset (--list and --tsv)", () => {
  assertParity(CI_LOCAL, [
    { name: "only-list", args: ["--only", "s2-agent", "--list"], expectCode: 0, out: ONLY_LIST_GOLDEN },
    { name: "only-tsv", args: ["--only", "s2-agent", "--tsv"], expectCode: 0, out: "s2-agent\tbun test && bun run typecheck" },
    { name: "only-eq-form", args: ["--only=s2-agent", "--tsv"], expectCode: 0, out: "s2-agent\tbun test && bun run typecheck" },
  ]);
});

test("ci-local.ts --only= (empty value) is the NO-FILTER quirk, not a usage error", () => {
  // bash quirk measured: the `--only=` form binds ONLY="" WITHOUT the
  // needs-a-value check, so an empty filter runs the WHOLE matrix. Pinned so
  // the port does not "fix" it into a usage error.
  assertParity(CI_LOCAL, [
    { name: "only-empty", args: ["--only=", "--tsv"], expectCode: 0, out: MATRIX_TSV_GOLDEN },
  ]);
});

test("ci-local.ts --gates --tsv and --gates --list (the regression-gates job)", () => {
  assertParity(CI_LOCAL, [
    { name: "gates-tsv", args: ["--gates", "--tsv"], expectCode: 0, out: GATES_TSV_GOLDEN },
    { name: "gates-list", args: ["--gates", "--list"], expectCode: 0, out: GATES_LIST_GOLDEN },
  ]);
});

// `--help`: the ported header (see the provenance note above — derived from the
// old script's captured header by the two naming substitutions).
const HELP_GOLDEN = [
	"# ci-local.ts — run the CI `tests` matrix locally, parsed live from the workflow.",
	"#",
	"# WHY THIS EXISTS",
	"#   GitHub Actions is disabled in this repo (.github/workflows/ holds only",
	"#   ci.yml.disabled, and `main` carries no branch-protection rule — see",
	"#   .github/CI.md). The matrix is therefore a SPECIFICATION that nothing",
	"#   executes. This script is the thing that executes it.",
	"#",
	"# THE ONE DESIGN RULE",
	"#   The package/command list is PARSED OUT OF .github/workflows/ci.yml.disabled",
	"#   at runtime. This script deliberately carries NO copy of the matrix. A second",
	"#   hand-maintained copy would drift from the first, and spec-vs-runner drift is",
	"#   the exact failure mode this repo keeps hitting (a stale dist/, a build.ts",
	"#   that never existed, a required check for a deleted package). If you add a",
	"#   matrix row, this script picks it up with no edit here — verify with --list.",
	"#",
	"# WHAT IT COVERS",
	"#   Two jobs, each parsed live, selected by flag:",
	"#     (default)  the `tests` matrix — every `- { package: X, test-cmd: Y }` row,",
	"#                run as `Y` inside bun-apps/X with CI=true (the same env var",
	"#                GitHub Actions sets, which the machine-coupled tests skip on).",
	"#     --gates    the `regression-gates` job — every `run:` step, in its own",
	"#                working-directory. That job is where EVERY structural guard",
	"#                lives (dep-direction, seam, routing, config-parity, CI-workflow",
	"#                references, package-script runnability, the portability and",
	"#                determinism audits). Before --gates existed, the guards were",
	"#                themselves a class with no local executor — precisely the",
	"#                failure they exist to prevent. The whole job runs in ~6s.",
	"#",
	"# WHAT IT DOES **NOT** COVER — a green run here is NOT a green CI:",
	"#   - extension-contract      (bun test src/__tests__/extension-contract.test.ts)",
	"#   - deploy-verify           (bun-apps/s2-agent-ext-devops/scripts/run-test.ts full — the high/readonly tiers are GONE)",
	"#   - compile-verify          (bun run deploy:exe + binary smokes)",
	"#   - clean-launch-self-heal  (clean-checkout check-deps.ts self-heal)",
	"#   - determinism-spotcheck   (3x the flake-prone subset; run it directly via",
	"#                              scripts/test-determinism-spotcheck.sh)",
	"#   - the changed_packages smart-routing filter (this script runs EVERYTHING,",
	"#     like push-to-main does, not the affected subset)",
	"#   Nor does it install deps: run `( cd bun-apps && bun install )` first if the",
	"#   tree is fresh.",
	"#",
	"# USAGE",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --list             # print the parsed matrix, run nothing",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --tsv              # machine-readable \"<pkg>\\t<cmd>\" lines",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts                    # run every matrix entry, sequentially",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --only s2-agent    # run a subset (comma-separated)",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --only a,b --list  # preview just that subset",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --gates            # run the regression-gates job instead",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --gates --list     # preview it",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --gates --jobs 2   # overlap the heavy gates (see BEHAVIOR)",
	"#",
	"#   --tsv exists so OTHER tools can consume the ONE parser rather than growing a",
	"#   second copy of the matrix — bun-apps/tests/ci-workflow-references.test.ts (the",
	"#   guard that every matrix row points at a real package, and every package has a",
	"#   row) reads it. Keep it decoration-free: no colors, no headers, no totals, and",
	"#   keep the plain form at exactly two fields: that IS the contract that guard",
	"#   depends on. `--gates --tsv` is the separate three-field form.",
	"#",
	"# TIMEOUTS (2026-08-24 — the operator's controllability ask: no gate may hang",
	"# the lane, and the whole gates run must fit a wall-clock budget)",
	"#   --gate-timeout-ms <ms>  per-gate hard kill cap (default 240000). A gate",
	"#                           that exceeds it FAILS as HUNG — a hang is a",
	"#                           failure signal, never something to wait out.",
	"#   --budget-ms <ms>        whole-run wall-clock budget (default 0 = off).",
	"#                           When the clock crosses it, every remaining gate",
	"#                           is SKIPPED (loudly, never silently) and the run",
	"#                           EXITS 1 listing them — budget exhaustion is a",
	"#                           FAIL, not a green.",
	"#   --jobs <n>              gates-only parallelism (default 1). n workers",
	"#                           pull gates; gates whose label matches the",
	"#                           EXCLUSIVE set (deploy-tree mutations: the",
	"#                           Deploy-sh L1 e2e builds and repoints deploy",
	"#                           state) serialize among themselves while the",
	"#                           read-only gates fill the lanes. The matrix run",
	"#                           stays sequential regardless — matrix entries",
	"#                           race s2-agent-ext-ultracode's shared dist/.",
	"# BEHAVIOR",
	"#   - Matrix: sequential (parallel runs race s2-agent-ext-ultracode's shared dist/)."
].join("\n");

test("ci-local.ts -h / --help (exit 0, the ported header)", () => {
  assertParity(CI_LOCAL, [
    { name: "help", args: ["-h"], expectCode: 0, out: HELP_GOLDEN },
    { name: "help-long", args: ["--help"], expectCode: 0, out: HELP_GOLDEN },
  ]);
});

test("ci-local.ts usage errors exit 2 (D4 exit-code law)", () => {
  assertParity(CI_LOCAL, [
    { name: "only-no-value", args: ["--only"], expectCode: 2, out: "--only needs a value" },
    { name: "bogus-flag", args: ["--bogus"], expectCode: 2, out: "unknown flag: --bogus (see --help)" },
    { name: "jobs-matrix-forbidden", args: ["--jobs", "2"], expectCode: 2, out: "--jobs > 1 applies to --gates only; the matrix run is sequential by contract" },
    { name: "jobs-not-int", args: ["--gates", "--jobs", "x"], expectCode: 2, out: "--jobs needs an integer ≥ 1" },
    { name: "gate-timeout-not-int", args: ["--gates", "--gate-timeout-ms", "abc"], expectCode: 2, out: "--gate-timeout-ms needs an integer ≥ 1000" },
    { name: "budget-not-int", args: ["--gates", "--budget-ms", "1"], expectCode: 2, out: "--budget-ms needs an integer ≥ 1000" },
    { name: "only-not-a-package", args: ["--only", "bogus", "--list"], expectCode: 2, out: "", errIncludes: ["ci-local FAILED: --only: 'bogus' is not a package in the .github/workflows/ci.yml.disabled tests matrix (run --list)"] },
    { name: "gates-plus-only", args: ["--gates", "--only", "x"], expectCode: 2, out: "--only filters matrix packages; it does not apply to --gates" },
  ]);
});
