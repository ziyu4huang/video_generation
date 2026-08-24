/**
 * run-test.ts parity — the portable bun twin of scripts/run-test.sh (tier
 * launcher). The old script is RETIRED on green; this test pins the contract
 * its consumers rely on (verify-tool parses the step summary, the
 * ci-workflow-references guard shelled out to --list-siblings).
 *
 * Provenance — goldens captured 2026-08-23 from the LIVE old script
 * (bun-apps/s2-agent-ext-devops/scripts/run-test.sh @ b69d3e3d, the last
 * commit before conversion; the .sh was deleted once parity went green), via:
 *   bash <abs>/scripts/run-test.sh --list          → rc 0, ANSI-exact tier table
 *   bash <abs>/scripts/run-test.sh --list-siblings → rc 0, byte-exact 3 names
 *   bash <abs>/scripts/run-test.sh --effort=bogus  → rc 2, stderr as pinned
 *   bash <abs>/scripts/run-test.sh quick           → live run (~90s), the
 *                                                    normalized tail pinned
 *                                                    below (elapsed was 91s)
 * `--list`, `-l` and `--list-siblings` are static (no timings, no /tmp paths),
 * so their goldens are EXACT — ANSI codes included. The quick-tier case is the
 * only live one (it runs the whole s2-agent unit suite as a child) — gated
 * behind RUN_TEST_LIVE_QUICK=1: the CI run of THIS package's `bun test` is NOT
 * the tier runner; the tier runner is the script under test.
 *
 * MEASURED divergence from the brief's claim ("unknown effort word → exit 2"):
 * only the `--effort=` form reaches the unknown-effort path. A bare
 * unrecognized word (e.g. "bogus") falls into EXTRA and is FORWARDED to
 * `bun test` as a filename filter — the old script ran the medium tier with a
 * bogus filter. The exit-2 case is therefore pinned via `--effort=bogus`
 * (measured rc 2, stdout empty).
 *
 * Second measured edge, NOT pinned because the old script hangs on it:
 * `--effort` with NO value — bash `shift 2` with one arg left loops forever.
 * The .ts treats a trailing `--effort` as `--effort=` (empty value) and falls
 * into the same unknown-effort exit-2 path.
 */
import { test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertParity } from "../../tests/helpers/bash-parity.ts"; // bun-apps/tests/helpers (two levels up: pkg/tests -> bun-apps)

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const RUN_TEST = join(PKG_DIR, "scripts", "run-test.ts");

// ── goldens (verbatim from the live run-test.sh, captured 2026-08-23) ──────

// 826 chars (UTF-16 units): the ANSI-colored tier table, byte-static. Note the
// script name inside the header/banner is preserved VERBATIM as "run-test.sh"
// — it is a display name within the parity contract (D4), not a call site.
const LIST_GOLDEN =
  "\u001b[33ms2-agent run-test.sh — effort tiers (each ⊇ the one above)\u001b[0m:\n\n  \u001b[32mquick\u001b[0m   \u001b[2m~0.2s\u001b[0m  unit only (pure fn + import-time smoke)\n  \u001b[32mmedium\u001b[0m  \u001b[2m~7s\u001b[0m    + the s2-agent package suite incl. the launcher e2e  \u001b[33m[default]\u001b[0m\n  \u001b[32msmoke\u001b[0m   \u001b[2m~30s\u001b[0m   LIVE LLM check vs deepseek/deepseek-v4-flash-vision-exp\n                            (the CI/E2E lane, 2026-08-24). Skips when DEEPSEEK_API_KEY\n                            is unset; a live provider error fails. Also folded into \u001b[32mfull\u001b[0m.\n  \u001b[32mfull\u001b[0m    \u001b[2m~40s\u001b[0m   + smoke + sibling pi-* unit baseline (whole stack)\n\nEnv gates the e2e test files read:\n  PI_AGENT_E2E=1          enable the launcher symlink-resolution block (medium+)\n\nThe deployed artifact's own e2e is a separate gate:\n  bash scripts/check-deploy-e2e.sh\n";

const SIBLINGS_GOLDEN = "s2-agent-ext-obsidian\ns2-agent-ext-knowledge-card\ns2-agent-ext-file2md\n";

test("run-test.ts --list / -l (ANSI-exact tier table, exit 0)", () => {
  assertParity(RUN_TEST, [
    { name: "list", args: ["--list"], expectCode: 0, out: LIST_GOLDEN },
    { name: "list-short", args: ["-l"], expectCode: 0, out: LIST_GOLDEN },
  ]);
});

test("run-test.ts --list-siblings (one bare name per line, exit 0)", () => {
  assertParity(RUN_TEST, [
    { name: "list-siblings", args: ["--list-siblings"], expectCode: 0, out: SIBLINGS_GOLDEN },
  ]);
});

test("run-test.ts unknown effort (--effort= form: exit 2 + stderr, stdout empty)", () => {
  assertParity(RUN_TEST, [
    {
      name: "unknown-effort",
      args: ["--effort=bogus"],
      expectCode: 2,
      out: "",
      // raw (unnormalized) stderr — ANSI stays; the matched substrings are
      // the ESC-free spans:
      errIncludes: [
        "unknown effort 'bogus' (want: quick|medium|smoke|full)",
        "try: ./run-test.sh --list",
      ],
    },
  ]);
});

test.skipIf(process.env.RUN_TEST_LIVE_QUICK !== "1")(
  "run-test.ts live quick tier (normalized output, exit 0)",
  () => {
    assertParity(RUN_TEST, [
      {
        name: "quick-live",
        args: ["quick"],
        expectCode: 0,
        outIs: "normalized",
        out: "▶ s2-agent run-test.sh — effort=quick\n✓ unit (quick)  (Ns)\n\n✓ effort=quick passed\n",
      },
    ]);
  },
);
