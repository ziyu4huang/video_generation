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
 * scripts/build.ts's stageGenerateRunDirBase(). `mode` and resolveBunAppsDir()
 * now live in run-context.ts so the split-out siblings branch identically.
 *
 * WHAT THIS FILE OWNS after the step-1c split: deploy-layout detection and argv
 * construction. Two neighbouring concerns moved out and are re-exported below,
 * so every existing import of this module still resolves:
 *   - deps-probe.ts      — "will these extensions be able to import what they
 *                          need?", auto-install, the missing-deps guide
 *   - lazy-extensions.ts — `-e <alias>` rewriting, which acts on the USER's argv
 *                          rather than on anything this file produces
 * The re-exports are one-hop: every line below names the module that DEFINES the
 * symbol, the invariant pi-agent-core-runtime's barrel had to be repaired to
 * restore (see its CONTEXT.md "One-hop barrel").
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.json";
import { detectMode } from "../src/mode.ts";
import type { UserSuppressFlags } from "../src/cli-argv.ts";
import { mode, resolveBunAppsDir, warn } from "./run-context.ts";
import {
  emitMissingDepsGuide,
  maybeAutoInstall,
  resolveNpmExtensionPaths,
} from "./deps-probe.ts";

// Re-export so callers (and tests) can import detectMode from the resolver
// surface; the implementation lives in the shared src/mode.ts.
export { detectMode };

// Exactly the symbols this module exported BEFORE the split — no more. `mode`,
// `resolveBunAppsDir`, `maybeAutoInstall`, `emitMissingDepsGuide` and
// `resolveNpmExtensionPaths` were module-private here and stay unexported from
// this surface; extraction is not a reason to widen the public API.
export {
  missingExtensionPackages,
  probeMissingExtensionDeps,
  runtimeDependencyNames,
} from "./deps-probe.ts";
export type { LazySettings } from "./lazy-extensions.ts";
export {
  looksLikeAlias,
  resolveLazyExtension,
  rewriteArgvLazyExtensions,
  rewriteExtensionArgs,
} from "./lazy-extensions.ts";

const url = import.meta.url;

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