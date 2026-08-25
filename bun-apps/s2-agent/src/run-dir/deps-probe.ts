/**
 * deps-probe.ts — "can the extensions this run-dir declares actually import
 * what they need?", plus the opt-in auto-install and the consolidated guide
 * that answer "no".
 *
 * Extracted from resolve.ts (spec step 1c). This is a distinct concern from the
 * rest of that file: resolve.ts decides WHICH paths to hand pi, this module
 * decides whether those paths will load once pi has them. The two only meet at
 * three call sites in resolveRunDirArgvUnfiltered.
 *
 * resolve.ts re-exports everything public here, so no consumer or test import
 * changed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "./manifest.json";
import { mode, warn } from "./run-context.ts";

// npm-sourced extensions were retired with the manifest's `npmExtensions`
// field (empty in its last years). What remains here probes the TRANSITIVE
// bare-specifier deps of the workspace extensions the manifest DOES declare.

// Set when an opt-in auto-install (`bun install`) completed successfully this
// invocation. Bun's in-process module resolver does NOT re-scan node_modules
// mid-process, so freshly installed packages usually aren't visible to the
// CURRENT process — they load on the next invocation. This flag lets
// emitMissingDepsGuide swap its "run bun install" advice for an honest
// "installed — re-run" hint instead of redundantly guiding the fix it just
// applied.
let autoInstalled = false;

/**
 * The dependency sections of a package.json that may be imported at runtime.
 * Kept narrow (only the three Bun populates) so the type is self-documenting.
 */
type PackageJsonWithDeps = {
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

/**
 * Names of packages an extension may import as bare specifiers at runtime,
 * unioned across ALL three declaration sections: dependencies +
 * peerDependencies + devDependencies, deduped, dependencies-first order.
 *
 * Why all three (not just `.dependencies`): in source mode the extensions load
 * via jiti, which resolves a bare specifier the SAME way regardless of how the
 * package classifies it. Several extensions import `@earendil-works/pi-tui`
 * (declared as a peerDependency) and `typebox` (a devDependency in some exts);
 * a probe that only read `.dependencies` was blind to both, so the pre-flight
 * self-heal in check-deps.ts never triggered for them and pi crashed on launch.
 * Source-mode `bun install` (never --production) materializes devDeps too, so
 * including them never produces a false "missing" on a healthy install — the
 * probe only tests specifiers the extension itself declares.
 */
export function runtimeDependencyNames(pkg: PackageJsonWithDeps): string[] {
	return Object.keys({
		...(pkg.dependencies ?? {}),
		...(pkg.peerDependencies ?? {}),
		...(pkg.devDependencies ?? {}),
	});
}

/**
 * Extension dependency packages (workspace OR npm) that are NOT resolvable from
 * their owning extension's package dir right now. The extensions themselves
 * load fine by ABSOLUTE PATH, but they import other packages as BARE
 * SPECIFIERS — e.g. knowledge-card.ts imports `@repo/s2-agent-ext-obsidian`,
 * power-tool imports `js-yaml`, web-access imports `@mozilla/readability`.
 * When `bun install` hasn't run (fresh clone / clean tree) those packages aren't
 * linked into node_modules, and pi's loader throws the unhelpful
 * `Cannot find module '<pkg>/…'` + `Hint: Start without extensions using "pi -ne"`
 * — which never points at `bun install`. This probe closes that gap by testing
 * the exact bare-specifier resolution the loader will use.
 *
 * MUST resolve from each extension's OWN dir, not from this module's context.
 * Bun's ISOLATED linker (bunfig.toml `linker = "isolated"`) enforces
 * phantom-dependency hygiene: a package resolves a bare specifier ONLY if that
 * package declares it in its own dependencies. s2-agent declares almost none of
 * the sibling extensions, so probing them from here (the old impl) reported
 * EVERY extension as missing — always — even on a healthy install. Resolving
 * each dep from `<bunAppsDir>/<extDir>` via `Bun.resolveSync(dep, extDir)`
 * mirrors the loader exactly, so detection is accurate. (The real package names
 * are also scoped — `@repo/s2-agent-ext-obsidian`, `@repo/…` — so we read
 * them from each extension's package.json dependency sections rather than
 * guessing the scope from the directory name.)
 *
 * Covers ALL three runtime-relevant sections — dependencies,
 * peerDependencies, AND devDependencies — because source-mode loading via
 * jiti resolves bare specifiers regardless of how the package classifies them,
 * and a missing peerDep is just as fatal as a missing dependency. The classic
 * victim is `@earendil-works/pi-tui`: most extensions import it but declare it
 * as a peerDependency, so a probe that only read `.dependencies` never reported
 * it missing → check-deps.ts skipped the self-heal → pi crashed on launch with
 * `Cannot find module '@earendil-works/pi-tui'` after every clean node_modules.
 * `typebox` (a runtime import declared as a devDependency in some exts) is the
 * same shape of bug. See `runtimeDependencyNames` above — the single source of
 * truth for which sections count.
 *
 * Returns missing dependency names, deduped.
 */
export function probeMissingExtensionDeps(bunAppsDir: string | undefined): string[] {
  if (mode !== "source") return [];
  if (!bunAppsDir) return [];
  // Distinct extension dirs from the manifest (top path segment of each entry).
  const dirs = new Set<string>();
  const consider = (entry: string | undefined): void => {
    if (!entry) return;
    const seg = entry.split("/")[0];
    // Skip relative/self entries (shouldn't occur here, but be safe).
    if (!seg || seg.startsWith(".")) return;
    dirs.add(seg);
  };
  for (const e of manifest.extensions) {
    consider(typeof e === "string" ? e : e?.entry);
  }
  // staticExtensions are bare dir names ("s2-agent-ext-task", not full
  // entry paths) and are loaded just like `extensions` — they MUST be probed
  // too, or a missing dep on a static extension (e.g. pi-tui on ext-task) is
  // invisible to the self-heal and crashes pi on launch.
  for (const e of manifest.staticExtensions ?? []) {
    consider(typeof e === "string" ? e : (e as { entry?: string })?.entry);
  }
  const missing: string[] = [];
  for (const dir of dirs) {
    const extDir = join(bunAppsDir, dir);
    let parsed: PackageJsonWithDeps;
    try {
      parsed = JSON.parse(readFileSync(join(extDir, "package.json"), "utf8"));
    } catch {
      // No/unreadable package.json for this extension dir — nothing to probe.
      continue;
    }
    for (const dep of runtimeDependencyNames(parsed)) {
      if (missing.includes(dep)) continue;
      // `<dep>/package.json` is the most reliable "is this package linked"
      // signal: every installed package has one, regardless of main/exports.
      try {
        Bun.resolveSync(`${dep}/package.json`, `${extDir}/`);
      } catch {
        missing.push(dep);
      }
    }
  }
  return missing;
}

/**
 * Union of transitive-workspace missing extension packages — the single signal
 * both the opt-in auto-install and the consolidated guide use. Exported so
 * src/run-dir/check-deps.ts can run the SAME detection pre-flight (before bun
 * boots) and install, so the loading process is fresh and sees deps.
 */
export function missingExtensionPackages(bunAppsDir: string | undefined): string[] {
  return probeMissingExtensionDeps(bunAppsDir);
}

/**
 * The ONE `bun install` invocation behind both install lanes: check-deps.ts's
 * pre-flight self-heal and maybeAutoInstall below. Same cwd + inherited stdio,
 * so the operator experience cannot drift. Each caller keeps its OWN gating —
 * deliberately different intents (pre-flight installs by DEFAULT so the launch
 * process is fresh and sees the deps; maybeAutoInstall is OPT-IN so `bun test`
 * / CI never mutate node_modules) — and its own success/failure messaging.
 */
export function runBunInstall(workspaceRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync("bun", ["install"], {
    cwd: workspaceRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/**
 * Opt-in auto-resolve. When BUN_PI_AUTO_INSTALL=1 (or the legacy
 * BUN_PI_AUTO_RESOLVE alias) and a declared npm extension package can't be
 * resolved in source mode, run `bun install` at the workspace root (bun-apps/); the
 * subsequent resolveNpmExtensionPaths() re-probes and picks up the install.
 * OFF by default: keeps `bun test` / CI deterministic and avoids a surprising
 * mutating side effect inside the interactive TUI. Deploy layouts are
 * self-contained (deps baked in) → always skipped. Returns true iff an install
 * was actually attempted.
 */
export function maybeAutoInstall(bunAppsDir: string | undefined): boolean {
  const opt = process.env.BUN_PI_AUTO_INSTALL ?? process.env.BUN_PI_AUTO_RESOLVE;
  if (opt !== "1" && opt !== "true") return false;
  if (mode !== "source") return false;
  const missing = missingExtensionPackages(bunAppsDir);
  if (missing.length === 0) return false;
  // bun-apps/ is the workspace root (package.json + bun.lock live here).
  const workspaceRoot = bunAppsDir ?? process.cwd();
  warn(
    `auto-resolve: ${missing.length} npm extension package(s) unresolved ` +
      `(${missing.join(", ")}) — running \`bun install\` at ${workspaceRoot}`,
  );
  const res = runBunInstall(workspaceRoot);
  if (res.status !== 0) {
    warn(
      `auto-resolve: \`bun install\` exited ${res.status ?? "null"}` +
        ` (signal ${res.signal ?? "none"}); falling back to guide`,
    );
    return false;
  }
  // Don't claim a same-process re-resolve: Bun's resolver typically won't see
  // the new node_modules entries until the next invocation. The re-probe in
  // buildArgv() picks them up only if Bun happens to re-scan; either way the
  // extensions are guaranteed to load on the NEXT run.
  autoInstalled = true;
  warn("auto-resolve: `bun install` completed — re-run this command to load the extensions");
  return true;
}

/**
 * Consolidated, actionable guidance emitted once after resolution when any
 * declared npm extension package remains unresolved (and any auto-install
 * attempt has run). Replaces N terse per-package "skipping" lines with one
 * block: the affected packages, the EXACT fix command at the workspace root,
 * root, and a note that the SAME `bun install` also clears the transitive
 * "Failed to load extension: Cannot find module" errors the pi extension
 * loader emits (e.g. pi-knowledge-card → pi-obsidian,
 * s2-agent-ext-power-tool → js-yaml) — those share the root cause. The missing
 * set now includes both declared npm extensions AND the workspace packages
 * sibling extensions import as bare specifiers (probeMissingExtensionDeps),
 * so the guide fires for the transitive case too, not only declared npm deps.
 * Silent when nothing is missing (zero noise on a healthy install) and in
 * non-source modes.
 */
export function emitMissingDepsGuide(bunAppsDir: string | undefined): void {
  if (mode !== "source") return;
  // If an auto-install just ran successfully, the fix was already applied —
  // don't redundantly advise `bun install`; the maybeAutoInstall() hint to
  // re-run is sufficient (the in-process resolver likely still can't see the
  // new deps, so `missing` may be non-empty here despite the install).
  if (autoInstalled) return;
  const missing = missingExtensionPackages(bunAppsDir);
  if (missing.length === 0) return;
  const workspaceRoot = bunAppsDir ?? "<bun-apps>";
  warn("──────── dependency resolution guide ────────");
  warn(
    `${missing.length} extension dependency package(s) are not installed ` +
      "(not linked into node_modules):",
  );
  for (const p of missing) warn(`  • ${p}`);
  warn("Some extensions were skipped or failed to load. Fix by installing deps at the workspace root (bun-apps/):");
  warn(`    cd ${workspaceRoot} && bun install`);
  warn(
    "This clears the loader's " +
      '"Failed to load extension: Cannot find module" errors thrown by ' +
      "extensions whose own imports are uninstalled (e.g. pi-obsidian, js-yaml).",
  );
  warn("Tip: set BUN_PI_AUTO_INSTALL=1 to run `bun install` automatically next time.");
  warn("─────────────────────────────────────────────");
}

/**
 * npm-sourced extensions no longer exist (the manifest's `npmExtensions` field
 * was retired empty). Kept as an always-empty export because resolve.ts
 * re-exports it and buildArgv() awaits it in the argv assembly — removing the
 * call site is churn without payoff.
 */
export async function resolveNpmExtensionPaths(): Promise<string[]> {
  return [];
}
