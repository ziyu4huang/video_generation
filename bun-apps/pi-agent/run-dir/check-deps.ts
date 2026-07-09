#!/usr/bin/env bun
/**
 * check-deps.ts — PRE-FLIGHT extension-dependency self-heal for source-mode
 * launches. Called by run.sh BEFORE `exec bun "$ENTRY"`, so the bun process
 * that actually loads the extensions (via bare-specifier imports like
 * `@repo/pi-agent-ext-obsidian`, `js-yaml`, `@mozilla/readability`) is FRESH and
 * sees a fully-linked node_modules on the FIRST launch.
 *
 * WHY THIS EXISTS (and why resolve.ts's mid-boot auto-install can't do it alone):
 * resolve.ts's `maybeAutoInstall` runs `bun install` from INSIDE pi's boot, but
 * Bun's in-process module resolver does NOT re-scan node_modules mid-process, so
 * the freshly installed packages aren't visible to the CURRENT launch — the user
 * had to run pi twice. Doing the install here, in a throwaway process BEFORE pi
 * boots, sidesteps that entirely: the subsequent `exec bun` is a new process that
 * resolves everything cleanly. One command from the user, fully fixed.
 *
 * Detection reuses resolve.ts's `missingExtensionPackages` (the same probe the
 * consolidated guide uses) so there is a single source of truth — no logic drift.
 *
 * Exit codes (consumed by run.sh, which ignores non-zero and proceeds anyway so
 * the user still gets pi + the in-process guide):
 *   0 — all extension deps resolvable, OR an install just completed successfully
 *   1 — deps missing AND install was skipped/failed (run.sh will launch pi; pi's
 *       loader will then print the actionable guide)
 *
 * Env:
 *   BUN_PI_AUTO_INSTALL=0|false — detect only, do NOT run `bun install`
 *     (default: install when missing). run.sh passes this through verbatim.
 *
 * No-op outside source mode: in bundle/binary deploy layouts the probe returns
 * [] (deps are baked in), so this exits 0 immediately.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve as pResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingExtensionPackages } from "./resolve.ts";

const url = import.meta.url;
// run-dir/ → pi-agent/ → bun-apps/  (mirrors resolve.ts's source-mode computation)
const bunAppsDir = pResolve(dirname(fileURLToPath(url)), "..", "..");
const repoRoot = pResolve(bunAppsDir, "..");

const missing = missingExtensionPackages(bunAppsDir);
if (missing.length === 0) process.exit(0);

const log = (msg: string): void => console.error(`[check-deps] ${msg}`);
log(`${missing.length} extension dependency package(s) unresolved (not linked into node_modules):`);
for (const m of missing) log(`  • ${m}`);

const opt = process.env.BUN_PI_AUTO_INSTALL;
if (opt === "0" || opt === "false") {
  log("BUN_PI_AUTO_INSTALL=0 — skipping auto-install; pi will print the guide");
  process.exit(1);
}

log(`running \`bun install\` at ${repoRoot} …`);
const res = spawnSync("bun", ["install"], {
  cwd: repoRoot,
  stdio: ["ignore", "inherit", "inherit"],
});
if (res.status === 0) {
  // The NEXT bun process (run.sh's `exec bun`) re-probes and will see the deps;
  // we don't claim a same-process re-resolve here either.
  log("install completed — continuing to launch");
  process.exit(0);
}
log(`\`bun install\` exited ${res.status ?? "null"} (signal ${res.signal ?? "none"}) — pi may fail to load some extensions`);
process.exit(1);
