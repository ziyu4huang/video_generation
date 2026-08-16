/**
 * resolve.ts — resolves this repo's fixed extension/skill set to ABSOLUTE paths,
 * independent of process.cwd(). This is what makes pi-agent "deploy to any path":
 * the vendored pi-coding-agent has no --cwd flag and threads process.cwd() into
 * every project-resource lookup (.pi/settings.json, .pi/extensions, etc.), so the
 * only cwd-independent hook it exposes is passing already-absolute paths via
 * -e/--skill CLI flags (resolvePath() returns absolute inputs unchanged, and
 * these paths are never trust-gated). See run-dir/manifest.json for the source
 * list and bun-apps/pi-agent/README.md for the full rationale.
 *
 * MODE DETECTION (same problem/pattern as src/patches/set-package-dir.ts):
 * Bun's bundler rewrites import.meta.url/import.meta.dir to the bundle output
 * location, so "resolve(import.meta.dir, '..', '..')" only computes the real
 * bun-apps/ dir in source mode. In bundle mode we load build-time-baked
 * absolute paths from src/generated/run-dir-base.ts (gitignored), written by
 * scripts/build.ts's stageGenerateRunDirBase().
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.json";
import { detectMode } from "../src/mode.ts";
import type { UserSuppressFlags } from "../src/cli-argv.ts";

// Re-export so callers (and tests) can import detectMode from the resolver
// surface; the implementation lives in the shared src/mode.ts.
export { detectMode };

// npm-sourced extensions ({ pkg, entry }) — manifest.json is the SINGLE source
// of truth: scripts/build.ts reads the same `npmExtensions` field to bake
// resolved paths into src/generated/run-dir-base.ts for bundle mode, so adding
// one is a one-file edit (not two). `entry` is relative to each package's root.
// These are plain `dependencies` in package.json, resolved via the shared
// node_modules tree (migrated off the old isolated .pi/npm/ tree).
//
// Deliberately NOT listed here:
//  - @juicesharp/rpiv-todo: this user's ~/.pi/agent/settings.json already
//    declares it as a global-scope package (loads for every pi invocation
//    regardless of cwd), so it behaves like the "personal data" meant to stay
//    at ~/.pi/. Baking a second copy here crashes with `Tool "todo" conflicts`
//    against the user's own global load. Another clone without that global
//    entry must add it to their own ~/.pi/agent/settings.json to get `todo`.
//  - pi-lens: was in the old .pi/npm install set but never in the active
//    .pi/settings.json packages list (installed-but-inert); intentionally
//    dropped. Add it here + to package.json if ever needed.
const NPM_EXTENSIONS = manifest.npmExtensions ?? [];

const url = import.meta.url;

// Mode detection is shared (src/mode.ts) — see detectMode(). Source marker for
// this module is "/run-dir/" (its default), so detectMode(url) is correct here.
const mode = detectMode(url);

function warn(msg: string) {
  console.error(`[bun-pi] run-dir: ${msg}`);
}

// Declared npm extension packages that import.meta.resolve could NOT find in
// this source-mode invocation. Populated by resolveNpmExtensionPaths() and
// reported once (consolidated, actionable) by emitMissingDepsGuide().
const missingNpm: string[] = [];

// Set when an opt-in auto-install (`bun install`) completed successfully this
// invocation. Bun's in-process module resolver does NOT re-scan node_modules
// mid-process, so the freshly installed packages usually aren't visible to the
// CURRENT resolveNpmExtensionPaths() — they load on the next invocation. This
// flag lets emitMissingDepsGuide swap its "run bun install" advice for an
// honest "installed — re-run" hint instead of redundantly guiding the fix it
// just applied.
let autoInstalled = false;

/**
 * Sync probe of which declared npm extension packages currently fail to
 * resolve. Pure-ish (read-only fs via import.meta.resolve); used for the
 * opt-in auto-install trigger and the consolidated guide so neither depends on
 * the per-package warn side-effect. No-op outside source mode (bundle mode
 * reads baked paths; binary mode loads no extensions).
 */
function probeMissingNpm(): string[] {
  if (mode === "bundle" || mode === "binary") return [];
  const missing: string[] = [];
  for (const { pkg } of NPM_EXTENSIONS) {
    try {
      import.meta.resolve(`${pkg}/package.json`);
    } catch {
      missing.push(pkg);
    }
  }
  return missing;
}

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
 * SPECIFIERS — e.g. knowledge-card.ts imports `@repo/pi-agent-ext-obsidian`,
 * power-tool imports `js-yaml`, web-access imports `@mozilla/readability`.
 * When `bun install` hasn't run (fresh clone / clean tree) those packages aren't
 * linked into node_modules, and pi's loader throws the unhelpful
 * `Cannot find module '<pkg>/…'` + `Hint: Start without extensions using "pi -ne"`
 * — which never points at `bun install`. This probe closes that gap by testing
 * the exact bare-specifier resolution the loader will use.
 *
 * MUST resolve from each extension's OWN dir, not from resolve.ts's context.
 * Bun's ISOLATED linker (bunfig.toml `linker = "isolated"`) enforces
 * phantom-dependency hygiene: a package resolves a bare specifier ONLY if that
 * package declares it in its own dependencies. pi-agent declares almost none of
 * the sibling extensions, so probing them from here (the old impl) reported
 * EVERY extension as missing — always — even on a healthy install. Resolving
 * each dep from `<bunAppsDir>/<extDir>` via `Bun.resolveSync(dep, extDir)`
 * mirrors the loader exactly, so detection is accurate. (The real package names
 * are also scoped — `@repo/pi-agent-ext-obsidian`, `@repo/…` — so we read
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
 * same shape of bug. See `runtimeDependencyNames` below — the single source of
 * truth for which sections count.
 *
 * Returns missing dependency names, deduped.
 */
export function probeMissingExtensionDeps(bunAppsDir: string | undefined): string[] {
  if (mode === "bundle" || mode === "binary") return [];
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
  // staticExtensions are bare dir names ("pi-agent-ext-task", not full
  // entry paths) and are loaded just like `extensions` — they MUST be probed
  // too, or a missing dep on a static extension (e.g. pi-tui on ext-task) is
  // invisible to the self-heal and crashes pi on launch.
  for (const e of manifest.staticExtensions ?? []) {
    consider(typeof e === "string" ? e : (e as { entry?: string })?.entry);
  }
  for (const e of Object.values(manifest.lazyExtensions ?? {})) {
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
 * Union of declared-npm + transitive-workspace missing extension packages — the
 * single signal both the opt-in auto-install and the consolidated guide use.
 * Deduped (a package can appear in both sources), manifest/npm order preserved.
 * Exported so run-dir/check-deps.ts can run the SAME detection pre-flight
 * (before bun boots) and install, so the loading process is fresh and sees deps.
 */
export function missingExtensionPackages(bunAppsDir: string | undefined): string[] {
  const out: string[] = [];
  for (const p of [...probeMissingNpm(), ...probeMissingExtensionDeps(bunAppsDir)]) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
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
function maybeAutoInstall(bunAppsDir: string | undefined): boolean {
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
  const res = spawnSync("bun", ["install"], {
    cwd: workspaceRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) {
    warn(
      `auto-resolve: \`bun install\` exited ${res.status ?? "null"}` +
        ` (signal ${res.signal ?? "none"}); falling back to guide`,
    );
    return false;
  }
  // Don't claim a same-process re-resolve: Bun's resolver typically won't see
  // the new node_modules entries until the next invocation. The re-probe in
  // buildArgv() below will pick them up only if Bun happens to re-scan; either
  // way the extensions are guaranteed to load on the NEXT run.
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
 * pi-agent-ext-power-tool → js-yaml) — those share the root cause. The missing
 * set now includes both declared npm extensions AND the workspace packages
 * sibling extensions import as bare specifiers (probeMissingWorkspaceDeps),
 * so the guide fires for the transitive case too, not only declared npm deps.
 * Silent when nothing is missing (zero noise on a healthy install) and in
 * non-source modes.
 */
function emitMissingDepsGuide(bunAppsDir: string | undefined): void {
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

// Bundle mode reads build-time-baked constants from run-dir-base.ts. Cache the
// dynamic import so resolveBunAppsDir and resolveNpmExtensionPaths share ONE
// load. The module is absent in a clean source tree; the try/catch covers that.
let runDirBase: Promise<{ bunAppsDir: string | undefined; npmPaths: string[] }> | null = null;
function loadRunDirBase() {
  if (mode === "bundle" && !runDirBase) {
    runDirBase = (async () => {
      try {
        // @ts-ignore — generated at build time; absent in a clean source tree
        const mod = await import("../src/generated/run-dir-base.ts");
        return {
          bunAppsDir: (mod.BUN_APPS_DIR as string | undefined) || undefined,
          npmPaths: (mod.NPM_EXTENSION_PATHS as string[] | undefined) ?? [],
        };
      } catch {
        return { bunAppsDir: undefined, npmPaths: [] };
      }
    })();
  }
  return runDirBase;
}

async function resolveBunAppsDir(): Promise<string | undefined> {
  if (mode === "bundle") {
    // Bundle mode: only the build-time-generated constant is reliable.
    return (await loadRunDirBase())?.bunAppsDir;
  }
  // Source mode: run-dir/resolve.ts -> pi-agent/ -> bun-apps/
  return resolve(dirname(fileURLToPath(url)), "..", "..");
}

async function resolveNpmExtensionPaths(): Promise<string[]> {
  if (mode === "bundle") {
    return (await loadRunDirBase())?.npmPaths ?? [];
  }
  const paths: string[] = [];
  for (const { pkg, entry } of NPM_EXTENSIONS) {
    try {
      const pkgJsonUrl = import.meta.resolve(`${pkg}/package.json`);
      const pkgDir = dirname(fileURLToPath(pkgJsonUrl));
      paths.push(join(pkgDir, entry));
    } catch {
      // Record for the consolidated guide (emitMissingDepsGuide); the per-line
      // message stays terse since the guide prints the exact fix once. Suppress
      // it entirely once an auto-install just ran (autoInstalled) — the
      // maybeAutoInstall() "re-run" hint already covers it and the in-process
      // resolver still can't see the new install in THIS invocation.
      if (!missingNpm.includes(pkg)) missingNpm.push(pkg);
      if (!autoInstalled) warn(`could not resolve npm package "${pkg}" — skipping`);
    }
  }
  return paths;
}

/**
 * Pure layout detector for {@link resolveRunDirArgv}: given the bundle's own
 * directory and an injected `exists`, decide which deploy layout (if any) is
 * present. Mirrors the precedence of resolveRunDirArgv's branch chain so the
 * detection is unit-testable without import.meta.url or real marker files.
 *   - "deploy-bundle"  : `.deploy-bundle` marker + `ext-bundles/` (deploy.ts default + --portable)
 *   - "deploy-package" : `packages/` + `run-dir/manifest.json` (deploy.ts --release)
 *   - "source"         : none of the above (repo source / a plain bundle with no markers)
 * Binary mode is decided separately by detectMode(url) (the $bunfs scheme), not
 * by selfDir, so it is NOT a layout mode here — resolveRunDirArgv guards on the
 * module-level `mode` first.
 */
export type RunDirLayoutMode = "deploy-bundle" | "deploy-package" | "source";
export function detectRunDirMode(selfDir: string, exists: (p: string) => boolean): RunDirLayoutMode {
  if (exists(join(selfDir, ".deploy-bundle")) && exists(join(selfDir, "ext-bundles"))) {
    return "deploy-bundle";
  }
  if (exists(join(selfDir, "packages")) && exists(join(selfDir, "run-dir", "manifest.json"))) {
    return "deploy-package";
  }
  return "source";
}

/**
 * Returns a flat argv fragment: ["-e", absPath, ..., "--skill", absPath, ...],
 * filtered by user-passed `-ne`/`-ns` (userFlags — computed by the caller from
 * the PRE-SPLICE argv, see src/patches/load-run-dir-resources.ts). The deploy
 * modes' own self-injected "-ne" is a bare token and survives the filter.
 */
export async function resolveRunDirArgv(
  userFlags: Partial<UserSuppressFlags> = {},
): Promise<string[]> {
  return suppressResolvedArgv(await resolveRunDirArgvUnfiltered(), userFlags);
}

async function resolveRunDirArgvUnfiltered(): Promise<string[]> {
  // Compiled-binary mode: emit NO -e flags — the default extension set ships
  // as STATIC factories instead (src/static-extensions.ts, native in-memory
  // call). Two reasons this stays -e-free even though upstream 0.80.10+ CAN
  // load user `-e <path>.ts` in a compiled binary (jiti virtualModules +
  // tryNative:false — verified live 2026-07-20): (1) the manifest's relative
  // .ts entries don't exist in the $bunfs virtual FS, and (2) import.meta.url
  // is the $bunfs scheme so the absolute-path resolution below would yield
  // garbage (e.g. BUN_APPS_DIR collapsing to "/", producing "/zai-mcp/…"
  // non-paths). A USER's own -e paths are untouched by this function and load
  // fine.
  //
  // `--skill` paths ARE emitted: @earendil-works/pi-coding-agent's skill
  // reader uses only node:fs (existsSync/readdirSync/readFileSync/statSync) —
  // zero jiti, zero dynamic code execution — and the extract-embedded-assets
  // patch extracts manifest.binarySkills' directories to a real on-disk dir
  // before this runs. Resolve them against that dir, falling back to
  // dirname(process.execPath) (the exe's own dir), mirroring how
  // getThemesDir()/getAssetsDir() resolve shipped assets in binary mode.
  if (mode === "binary") {
    // --compile-embed mode: extract-embedded-assets patch sets BUN_PI_EMBEDDED_EXTRACT_DIR
    // before this runs (during applyPatches). Use that dir for skill resolution.
    const embedDir = process.env.BUN_PI_EMBEDDED_EXTRACT_DIR;
    const exeDir = dirname(process.execPath);
    const baseDir = embedDir && existsSync(embedDir) ? embedDir : exeDir;
    const argv: string[] = [];
    for (const rel of manifest.binarySkills ?? []) {
      const p = join(baseDir, rel);
      if (existsSync(p)) {
        argv.push("--skill", p);
      } else if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
        warn(`binary mode: skill path not found, skipping: ${p}`);
      }
    }
    if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
      warn(`compiled-binary mode — default extensions ship as static factories; emitting ${argv.length / 2} --skill flag(s)`);
    }
    return argv;
  }

  const selfDir = dirname(fileURLToPath(url));
  const layoutMode = detectRunDirMode(selfDir, existsSync);

  // DEPLOY-BUNDLE mode: the DEFAULT output of `scripts/deploy.ts` (no --release)
  // — the bundle sits next to its own `ext-bundles/*.thin.js` (pre-bundled
  // single-file extensions) + a copied `node_modules/` + `.deploy-bundle`
  // marker. The dir listing is the source of truth (NOT manifest.extensions,
  // which still names source .ts paths). Uses `-ne` for the same self-contained
  // reason as DEPLOY-PACKAGE. Checked before `packages/` since the two layouts
  // are mutually exclusive (deploy.ts emits one or the other).
  if (layoutMode === "deploy-bundle") {
    const extBundlesDir = join(selfDir, "ext-bundles");
    if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
      warn(`deploy-bundle mode — resolving from ${extBundlesDir}`);
    }
    // npm exts resolve to the same baked .bun-store abs paths the THIN bundles
    // and pi-agent.js itself use (everything in this layout is machine-abs-pathed).
    // EXCEPT in --portable: npm exts are FULL-bundled into ext-bundles (no
    // separate -e path), and the baked abs paths would re-introduce a repo
    // dependency, so emit none.
    //
    // DEAD BRANCH: nothing writes `.deploy-portable`. deploy.ts accepts only
    // --bundle/--snapshot/--standalone/--exe (`--portable` hard-errors) and
    // writes only `.deploy-bundle`/`.deploy-readonly`. This and the
    // `deploy-package` mode below are leftovers from the rename that doctor.ts
    // has now been cleaned of; removing them here also means retiring
    // detectRunDirMode's exported "deploy-package" variant and its tests, so it
    // is tracked as its own change. Not evidence that --portable exists.
    const portable = existsSync(join(selfDir, ".deploy-portable"));
    const npmPaths = portable ? [] : await resolveNpmExtensionPaths();
    return ["-ne", ...buildBundleArgv(selfDir, npmPaths)];
  }

  // DEPLOY-PACKAGE mode: a self-contained package produced by `scripts/deploy.ts
  // --release` — the bundle sits next to its own `packages/<pkg>/…` tree +
  // `run-dir/manifest.json`. Resolve the manifest against packages/ (NOT the
  // repo's bun-apps/, and NOT the build-time-baked run-dir-base.ts, which points
  // at the repo). Uses `-ne` so the package is self-contained: pi loads ONLY
  // these -e paths and ignores any <cwd>/.pi/ — avoiding cross-path tool-name
  // conflicts when the package is run inside a repo that declares the same
  // extensions from different paths.
  if (layoutMode === "deploy-package") {
    const packagesDir = join(selfDir, "packages");
    if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
      warn(`deploy-package mode — resolving manifest against ${packagesDir}`);
    }
    return ["-ne", ...(await buildArgv(packagesDir))];
  }

  // SOURCE / repo-bundle modes: additive layering (no -ne) with <cwd>/.pi/ +
  // ~/.pi/. Safe because run-dir resolves to the same canonical bun-apps/ paths
  // a repo .pi/ would, so pi dedupes them.
  const bunAppsDir = await resolveBunAppsDir();
  // Opt-in: if a declared npm ext is missing and the user set
  // BUN_PI_AUTO_INSTALL=1, run `bun install` at the workspace root (bun-apps/) BEFORE building
  // argv (buildArgv re-probes via resolveNpmExtensionPaths and picks it up).
  maybeAutoInstall(bunAppsDir);
  const argv = await buildArgv(bunAppsDir);
  // Always-on (source mode only): if anything is STILL missing after any
  // auto-install attempt, emit one consolidated, actionable guide block.
  emitMissingDepsGuide(bunAppsDir);
  return argv;
}

/**
 * Build the -e/--skill argv from the manifest against a bun-apps-equivalent
 * base dir (undefined → skip workspace-local entries, warn). npm extensions
 * resolve from node_modules regardless of base.
 */
async function buildArgv(bunAppsDir: string | undefined): Promise<string[]> {
  return buildArgvFromManifest(
    manifest,
    bunAppsDir,
    await resolveNpmExtensionPaths(),
    existsSync,
    warn,
  );
}

/**
 * DEPLOY-BUNDLE argv builder. Resolves from the out-dir layout produced by
 * `scripts/deploy.ts` (no --release): `ext-bundles/*.js` + npm ext abs paths +
 * `skills/<dir>`. The dir listing of ext-bundles is the source of truth (the
 * bundles are pre-built single files, NOT the source paths named in
 * manifest.extensions). npmPaths are the baked .bun-store abs paths (same
 * machine-abs-pathed model the THIN bundles + pi-agent.js itself use).
 */
function buildBundleArgv(selfDir: string, npmPaths: string[]): string[] {
  // existsSync is true for FILES too, so a stray file named `ext-bundles` or
  // `skills` would make readdirSync throw ENOTDIR and crash argv resolution
  // (→ no extensions load). Treat any read failure — ENOTDIR, ENOENT, EACCES —
  // as "empty listing" so a malformed layout degrades to "no ext-bundles" the
  // same way a missing one does, instead of throwing.
  const readDir = (d: string) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
  return buildBundleArgvFromLayout(
    {
      extBundles: readDir(join(selfDir, "ext-bundles")).filter((f) => f.endsWith(".js")),
      skillDirs: readDir(join(selfDir, "skills")),
      npmPaths,
    },
    selfDir,
    existsSync,
    warn,
  );
}

/**
 * Pure DEPLOY-BUNDLE argv builder — everything passed in, no fs. Exported so the
 * ext-bundles + npm + skills assembly is unit-testable.
 *
 *   - ext-bundles → `-e <selfDir>/ext-bundles/<file>` (one per bundled .js)
 *   - npm exts    → `-e <absPath>` (the baked .bun-store path, when it exists)
 *   - skills      → `--skill <selfDir>/skills/<dir>`
 *   - missing npm → skipped + warned (not fatal — some bundles may inline it)
 */
export function buildBundleArgvFromLayout(
  layout: { extBundles: string[]; skillDirs: string[]; npmPaths: string[] },
  selfDir: string,
  exists: (p: string) => boolean,
  warnFn: (msg: string) => void,
): string[] {
  const argv: string[] = [];
  for (const f of layout.extBundles) {
    argv.push("-e", join(selfDir, "ext-bundles", f));
  }
  for (const p of layout.npmPaths) {
    if (exists(p)) {
      argv.push("-e", p);
    } else {
      warnFn(`deploy-bundle: npm extension path not found, skipping: ${p}`);
    }
  }
  for (const dir of layout.skillDirs) {
    argv.push("--skill", join(selfDir, "skills", dir));
  }
  return argv;
}

/**
 * Pure argv builder — everything passed in, no fs/network. Exported so the
 * -e/--skill assembly + skip-on-missing logic is unit-testable without the
 * mode/env machinery of buildArgv.
 *
 *   - workspace extensions → `-e <base>/<rel>` (only when `exists` says so)
 *   - npm extensions       → appended after workspace, as `-e <absPath>`
 *   - skills               → `--skill <base>/<rel>`
 *   - missing paths        → skipped, reported via `warnFn`
 *   - undefined base       → workspace extensions AND skills skipped + warned
 */
export function buildArgvFromManifest(
  m: { extensions?: (string | { entry?: string })[]; skills?: string[] },
  bunAppsDir: string | undefined,
  npmPaths: string[],
  exists: (p: string) => boolean,
  warnFn: (msg: string) => void,
): string[] {
  const argv: string[] = [];
  const extensionPaths: string[] = [];
  if (bunAppsDir) {
    for (const entry of m.extensions ?? []) {
      const rel = typeof entry === "string" ? entry : entry.entry;
      if (!rel) {
        // A declared object missing `entry` (malformed manifest) would otherwise
        // throw an opaque TypeError inside path.join and crash launch. Skip +
        // warn so the runtime failure mode matches the contract test. (I-1)
        warnFn(`manifest extension missing 'entry', skipping: ${JSON.stringify(entry)}`);
        continue;
      }
      extensionPaths.push(join(bunAppsDir, rel));
    }
  } else {
    warnFn("could not determine bun-apps/ directory — skipping workspace-local extensions");
  }
  extensionPaths.push(...npmPaths);
  for (const p of extensionPaths) {
    if (exists(p)) {
      argv.push("-e", p);
    } else {
      warnFn(`extension path not found, skipping: ${p}`);
    }
  }
  if (bunAppsDir) {
    for (const rel of m.skills ?? []) {
      const p = join(bunAppsDir, rel);
      if (exists(p)) {
        argv.push("--skill", p);
      } else {
        warnFn(`skill path not found, skipping: ${p}`);
      }
    }
  }
  return argv;
}

/**
 * Drop `-e <path>` / `--skill <path>` pairs from a RUN-DIR-RESOLVED argv
 * fragment according to user-passed suppression flags (see
 * src/cli-argv.ts userSuppressFlags). Only ever applied to the argv THIS
 * module produced — the user's own `-e <path>` flags live elsewhere in
 * process.argv and are untouched, which matches upstream pi's `-ne`
 * semantics (explicit CLI extensions still load under -ne).
 * Bare tokens (the deploy modes' self-injected "-ne") pass through.
 */
export function suppressResolvedArgv(
  argv: string[],
  flags: Partial<UserSuppressFlags>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (flags.noExtensions && (tok === "-e" || tok === "--extension")) {
      i++; // skip payload
      continue;
    }
    if (flags.noSkills && tok === "--skill") {
      i++; // skip payload
      continue;
    }
    out.push(tok);
  }
  return out;
}

// ─── Lazy / opt-in extension aliases ──────────────────────────────────────────
//
// Bare-name aliases (`-e workflow`) that rewrite to absolute extension paths
// BEFORE main() reads argv. This sidesteps the long-path mis-type problem and
// the `src/workflow.ts` "valid factory function" trap — the alias always points
// at the real factory file.
//
// HISTORY: this mechanism was originally created so heavy extensions could stay
// OUT of manifest.json (zero cost on default sessions). pi-agent-ext-workflow
// was promoted to eager (default-enabled) on 2026-07-10 — it now lives in BOTH
// manifest.extensions AND lazyExtensions. That is intentional and safe: the SDK
// loader (core/extensions/loader.ts discoverAndLoadExtensions) dedups by resolved
// path, so `-e workflow` from a user's old script + the eager splice resolve to
// the same canonical path and the duplicate is skipped (no double registration).
// The aliases are kept purely for backwards-compat (20+ scripts/docs/samples pass
// `-e workflow`).

/** Re-export the lazy registry (typed) for tests/inspectors. */
export interface LazySettings {
  lazyExtensions?: Record<string, string>;
}
const lazySettings: LazySettings = manifest;

/**
 * Bare-alias guard. Only fuzzy-resolve plain names like `workflow`,
 * `dynamic-workflows`. Anything that looks like a path (contains `/` or `\`,
 * or starts with `.`) or a URL scheme (`npm:`, `git:`, `http(s):`, `file:`) is
 * left for the SDK's own resolver — we never hijack real paths.
 */
export function looksLikeAlias(input: string): boolean {
  if (!input) return false;
  if (/[\\/]/.test(input)) return false; // path separator → real path
  if (input.startsWith(".")) return false; // ./… or ~/… → leave alone
  // scheme prefix (npm:pkg, git:…, http(s):…, file:…) → leave to SDK
  if (/^(npm|git|https?|file):/i.test(input)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input);
}

/**
 * Resolve a bare alias to an absolute extension path, or `undefined` to defer
 * to the SDK. Pure: all fs access is via the injected `exists`. Resolution order
 * (first hit wins):
 *   1. not a bare alias → undefined
 *   2. exact case-insensitive key match (existing file)
 *   3. unique case-insensitive substring match (≥2 → ambiguous, no guess)
 *   4. directory fallback: <bunAppsDir>/<alias>/extensions/ has exactly one .ts
 *   5. else undefined
 */
export function resolveLazyExtension(
  input: string,
  s: LazySettings,
  bunAppsDir: string | undefined,
  exists: (p: string) => boolean,
  warnFn?: (m: string) => void,
): string | undefined {
  if (!looksLikeAlias(input)) return undefined;

  const toAbs = (v: string) => (isAbsolute(v) ? v : bunAppsDir ? join(bunAppsDir, v) : v);
  const lazy = s.lazyExtensions ?? {};

  // 2. exact key match (case-insensitive)
  const exactKey = Object.keys(lazy).find((k) => k.toLowerCase() === input.toLowerCase());
  if (exactKey) {
    const p = toAbs(lazy[exactKey]!);
    if (exists(p)) return p;
    warnFn?.(`lazy alias "${input}" → ${p} does not exist; leaving for SDK`);
    return undefined;
  }

  // 3. substring match (input ⊆ key)
  const lower = input.toLowerCase();
  const substring = Object.keys(lazy).filter((k) => k.toLowerCase().includes(lower));
  if (substring.length === 1) {
    const p = toAbs(lazy[substring[0]!]!);
    if (exists(p)) return p;
    warnFn?.(`lazy alias "${input}" → ${p} does not exist; leaving for SDK`);
    return undefined;
  }
  if (substring.length > 1) {
    warnFn?.(`lazy alias "${input}" is ambiguous (matches ${substring.join(", ")}); leaving for SDK`);
    return undefined;
  }

  // 4. directory fallback: <bunAppsDir>/<alias>/extensions/*.ts (exactly one)
  if (bunAppsDir) {
    const dir = join(bunAppsDir, input, "extensions");
    if (exists(dir)) {
      // `exists` (existsSync) is true for files too: if <alias>/extensions is a
      // file, readdirSync throws ENOTDIR. Treat that as "fallback doesn't apply"
      // (return undefined below) rather than crashing argv resolution.
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        entries = [];
      }
      const ts = entries.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      if (ts.length === 1) return join(dir, ts[0]!);
      if (ts.length > 1) {
        warnFn?.(`lazy alias "${input}" → ${dir} has ${ts.length} .ts files; can't pick; leaving for SDK`);
      }
    }
  }

  return undefined;
}

/**
 * Return a NEW argv where every `-e`/`--extension` value that resolves via
 * `resolve` is replaced by its absolute path. Non-alias values, unresolved
 * aliases, and the rest of argv are passed through untouched.
 */
export function rewriteExtensionArgs(
  argv: string[],
  resolve: (input: string) => string | undefined,
  warnFn?: (m: string) => void,
): string[] {
  const out = argv.slice();
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === "-e" || out[i] === "--extension") {
      const val = out[i + 1]!;
      const resolved = resolve(val);
      if (resolved && resolved !== val) {
        out[i + 1] = resolved;
        warnFn?.(`-e ${val} → ${resolved}`);
      }
    }
  }
  return out;
}

/**
 * Orchestrator: resolve bunAppsDir (source/bundle) and rewrite `-e <alias>`
 * values in `argv` in place. No-op in binary mode (no repo bun-apps/ to resolve
 * against) — mirrors resolveRunDirArgv's guard.
 */
export async function rewriteArgvLazyExtensions(argv: string[]): Promise<void> {
  if (mode === "binary") return;
  const bunAppsDir = await resolveBunAppsDir();
  const before = argv.slice();
  const debug = process.env.BUN_PI_DEBUG_RUN_DIR === "1";
  const next = rewriteExtensionArgs(
    argv,
    (v) => resolveLazyExtension(v, lazySettings, bunAppsDir, existsSync, warn),
    debug ? (m) => console.error(`[bun-pi] run-dir: ${m}`) : undefined,
  );
  // mutate in place
  argv.length = 0;
  argv.push(...next);
  if (process.env.BUN_PI_DEBUG_RUN_DIR === "1" && JSON.stringify(before) !== JSON.stringify(next)) {
    console.error("[bun-pi] run-dir: rewrote lazy extension aliases");
  }
}
