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
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { dirname, join, resolve as pResolve } from "node:path";
import { fileURLToPath } from "node:url";
// Straight from deps-probe.ts, which DEFINES it, not through resolve.ts's
// facade: this runs as a pre-flight before pi boots, and going via the facade
// would load the layout/argv builders and the lazy-alias resolver for a probe
// that needs neither.
import { missingExtensionPackages } from "./deps-probe.ts";

const url = import.meta.url;
// run-dir/ → pi-agent/ → bun-apps/  (mirrors resolve.ts's source-mode computation).
// bun-apps/ IS the Bun workspace root (package.json + bun.lock + bunfig.toml live
// here), so `bun install` must run here — NOT at the repo root.
const bunAppsDir = pResolve(dirname(fileURLToPath(url)), "..", "..");

const missing = missingExtensionPackages(bunAppsDir);
if (missing.length === 0) process.exit(0);

// Classify each missing package as a workspace member (resolves to local source
// after `bun install`, but is NEVER materialized into node_modules under Bun's
// isolated linker) vs an external npm package. A workspace package showing up
// here is the NORMAL one-time state right after a dependency-adding update
// (rename, new sibling import): Bun.resolveSync needs `bun install` to have run
// at least once before it can resolve workspace globs, even though install never
// symlinks those packages into node_modules. Labeling the kind makes the message
// read as a benign self-heal instead of a broken install.
const workspaceNames = workspacePackageNames(bunAppsDir);

const log = (msg: string): void => console.error(`[check-deps] ${msg}`);
log("pre-flight self-heal — this is normal once after a dependency update:");
log(`${missing.length} extension dependency package(s) not yet resolvable:`);
for (const m of missing) {
  const kind = workspaceNames.has(m) ? "workspace dep → resolves to source" : "npm dep";
  log(`  • ${m}  (${kind})`);
}

const opt = process.env.BUN_PI_AUTO_INSTALL;
if (opt === "0" || opt === "false") {
  log("BUN_PI_AUTO_INSTALL=0 — skipping auto-install; pi will print the guide");
  process.exit(1);
}

log(`running \`bun install\` at ${bunAppsDir} (workspace root) …`);
const res = spawnSync("bun", ["install"], {
  cwd: bunAppsDir,
  stdio: ["ignore", "inherit", "inherit"],
});
if (res.status === 0) {
  // The NEXT bun process (run.sh's `exec bun`) re-probes and will see the deps;
  // we don't claim a same-process re-resolve here either.
  log("install completed — won't recur next launch; continuing to launch");
  process.exit(0);
}
log(`\`bun install\` exited ${res.status ?? "null"} (signal ${res.signal ?? "none"}) — pi may fail to load some extensions`);
process.exit(1);

/**
 * Names of workspace packages published under <bunAppsDir>/* (each sub-dir's
 * package.json `name`). Used only to label missing deps as workspace vs npm in
 * the self-heal message — cheap (≤ ~20 dirs), read-only, best-effort.
 */
function workspacePackageNames(bunAppsDir: string): Set<string> {
  const names = new Set<string>();
  let entries: Dirent[];
  try {
    entries = readdirSync(bunAppsDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const pj = join(bunAppsDir, ent.name, "package.json");
    if (!existsSync(pj)) continue;
    try {
      const name = JSON.parse(readFileSync(pj, "utf8")).name;
      if (typeof name === "string") names.add(name);
    } catch {
      // Unreadable package.json — skip; labeling is best-effort.
    }
  }
  return names;
}
