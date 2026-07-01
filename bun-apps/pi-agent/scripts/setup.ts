/**
 * setup — ensure the monorepo workspace is installed so pi's extensions load.
 *
 * WHY THIS EXISTS
 *   pi-agent is run from source (`bun src/cli.ts`). pi then loads every
 *   extension declared in `.pi/settings.json`. Those extensions import their
 *   workspace peers as bare specifiers (pi-knowledge-card → pi-obsidian), and
 *   that resolution only works after `bun install` at the monorepo ROOT
 *   (never inside pi-agent/). Forget that one step and pi dies on startup with
 *       Cannot find module 'pi-obsidian/extensions/obsidian.ts'
 *   This script makes the prerequisite automatic and idempotent.
 *
 * WHAT IT DOES
 *   1. Locate the repo root (walks up from cwd / this file — never assumes cwd).
 *   2. Probe real module resolution for every local pi-package's workspace
 *      peers (same check the cli.ts startup guard uses — see src/preflight.ts).
 *   3. If any resolution fails, run `bun install` at the repo root and re-probe.
 *
 * USAGE
 *   bun scripts/setup.ts            # probe, install if needed, re-probe
 *   bun scripts/setup.ts --check    # report status only, exit non-zero if broken
 *   bun scripts/setup.ts -h|--help  # print this header
 *
 * Run from anywhere — the script resolves the repo root from its own location.
 */
import { resolve as resolvePath } from "node:path";
import {
  findPiRepoRoot,
  probeWorkspaceDeps,
  type ProbeResult,
} from "../src/preflight.ts";

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check");
if (argv.some((a) => a === "-h" || a === "--help")) {
  // Print the doc header above.
  const src = await Bun.file(import.meta.path).text();
  const header = src.split("*/")[0].replace(/^\/\*\*?|\*\/?$/gm, "").trim();
  console.log(header);
  process.exit(0);
}
for (const a of argv) {
  if (a !== "--check") {
    console.error(`error: unknown flag: ${a} (try --help)`);
    process.exit(2);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

function report(r: ProbeResult): void {
  console.log(
    `${D("repo root:")} ${r.repoRoot ?? "(not found — not a pi monorepo)"}`,
  );
  console.log(`${D("checked:")}  ${r.checks} resolution(s) across ${r.localPackages.length} local package(s)`);
  if (r.failures.length === 0) {
    console.log(G("✓ all workspace peers resolve"));
  } else {
    console.log(R("✗ missing workspace resolutions:"));
    for (const f of r.failures) {
      console.log(`    ${f.from} → ${f.dep}`);
      console.log(D(`      ${f.error}`));
    }
  }
}

// ── locate repo root ─────────────────────────────────────────────────────────
const repoRoot = findPiRepoRoot();
if (!repoRoot) {
  console.error(
    Y("· not a pi monorepo (no .pi/settings.json + workspace package.json found); nothing to do."),
  );
  process.exit(0);
}

// ── initial probe ────────────────────────────────────────────────────────────
console.log("▶ probe workspace resolutions");
let result = await probeWorkspaceDeps({ repoRoot });
report(result);

if (result.ok) process.exit(0);
if (CHECK_ONLY) process.exit(1);

// ── install at the repo root ─────────────────────────────────────────────────
// `bun install` must run at the root (where workspaces are declared), never
// inside pi-agent/ — README documents this same rule.
console.log("");
console.log(G("▶") + ` bun install  ${D(`(cwd: ${repoRoot})`)}`);
const proc = Bun.spawn(["bun", "install"], {
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
if (code !== 0) {
  console.error(R(`✗ bun install exited ${code}`));
  process.exit(code);
}

// ── re-probe ─────────────────────────────────────────────────────────────────
console.log("");
console.log("▶ re-probe workspace resolutions");
result = await probeWorkspaceDeps({ repoRoot });
report(result);
if (!result.ok) {
  console.error("");
  console.error(
    R("✗ resolutions still failing after `bun install`."),
  );
  console.error(
    D(`    inspect the failing packages under ${resolvePath(repoRoot, "bun-apps")}`),
  );
  process.exit(1);
}
