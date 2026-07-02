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
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.json";
import settings from "./settings.json";
import { detectMode } from "../src/mode.ts";

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
      warn(`could not resolve npm package "${pkg}" — skipping (run \`bun install\` at repo root?)`);
    }
  }
  return paths;
}

/** Returns a flat argv fragment: ["-e", absPath, ..., "--skill", absPath, ...] */
export async function resolveRunDirArgv(): Promise<string[]> {
  // Compiled-binary mode: no-op. pi can't load .ts extensions here anyway
  // (jiti feeds each extension as a base64 data: URL → Bun ENAMETOOLONG — see
  // README "Build modes"), and import.meta.url is the $bunfs virtual scheme so
  // the absolute-path resolution below yields garbage (e.g. BUN_APPS_DIR
  // collapsing to "/", producing "/zai-mcp/…" non-paths). Without this guard
  // every binary invocation — even --version — spews ~7 "skipping" warnings.
  // The bundled .js (not the --compile binary) is the supported shipped path.
  if (mode === "binary") {
    if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
      warn("compiled-binary mode — extensions can't load here; returning no argv");
    }
    return [];
  }

  const selfDir = dirname(fileURLToPath(url));

  // DEPLOY-BUNDLE mode: the DEFAULT output of `scripts/deploy.ts` (no --release)
  // — the bundle sits next to its own `ext-bundles/*.thin.js` (pre-bundled
  // single-file extensions) + a copied `node_modules/` + `.deploy-bundle`
  // marker. The dir listing is the source of truth (NOT manifest.extensions,
  // which still names source .ts paths). Uses `-ne` for the same self-contained
  // reason as DEPLOY-PACKAGE. Checked before `packages/` since the two layouts
  // are mutually exclusive (deploy.ts emits one or the other).
  const extBundlesDir = join(selfDir, "ext-bundles");
  if (existsSync(join(selfDir, ".deploy-bundle")) && existsSync(extBundlesDir)) {
    if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
      warn(`deploy-bundle mode — resolving from ${extBundlesDir}`);
    }
    // npm exts resolve to the same baked .bun-store abs paths the THIN bundles
    // and pi-agent.js itself use (everything in this layout is machine-abs-pathed).
    // EXCEPT in --portable: npm exts are FULL-bundled into ext-bundles (no
    // separate -e path), and the baked abs paths would re-introduce a repo
    // dependency, so emit none.
    const portable = existsSync(join(selfDir, ".deploy-portable"));
    const npmPaths = portable ? [] : await resolveNpmExtensionPaths();
    return ["-ne", ...buildBundleArgv(selfDir, npmPaths)];
  }

  // DEPLOY-PACKAGE mode: a self-contained package produced by `scripts/deploy.ts
  // --release` — the bundle sits next to its own `packages/<pkg>/…` tree +
  // — the bundle sits next to its own `packages/<pkg>/…` tree + `run-dir/manifest.json`.
  // Resolve the manifest against packages/ (NOT the repo's bun-apps/, and NOT
  // the build-time-baked run-dir-base.ts, which points at the repo). Uses `-ne`
  // so the package is self-contained: pi loads ONLY these -e paths and ignores
  // any <cwd>/.pi/ — avoiding cross-path tool-name conflicts when the package is
  // run inside a repo that declares the same extensions from different paths.
  const packagesDir = join(selfDir, "packages");
  if (existsSync(packagesDir) && existsSync(join(selfDir, "run-dir", "manifest.json"))) {
    if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
      warn(`deploy-package mode — resolving manifest against ${packagesDir}`);
    }
    return ["-ne", ...(await buildArgv(packagesDir))];
  }

  // SOURCE / repo-bundle modes: additive layering (no -ne) with <cwd>/.pi/ +
  // ~/.pi/. Safe because run-dir resolves to the same canonical bun-apps/ paths
  // a repo .pi/ would, so pi dedupes them.
  return buildArgv(await resolveBunAppsDir());
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
  const readDir = (d: string) => (existsSync(d) ? readdirSync(d) : []);
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
  m: { extensions?: string[]; skills?: string[] },
  bunAppsDir: string | undefined,
  npmPaths: string[],
  exists: (p: string) => boolean,
  warnFn: (msg: string) => void,
): string[] {
  const argv: string[] = [];
  const extensionPaths: string[] = [];
  if (bunAppsDir) {
    for (const rel of m.extensions ?? []) {
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

// ─── Lazy / opt-in extension aliases ──────────────────────────────────────────
//
// Heavy extensions (e.g. pi-dynamic-workflows, ~2.5k tok/req) are deliberately
// NOT in manifest.json (which loads eagerly every session). Instead they are
// registered here as aliases and loaded only when the user passes `-e <alias>`.
// This file rewrites such `-e <alias>` argv values to absolute paths BEFORE
// main() reads argv, so default sessions pay zero cost and there is no long
// path to mis-type (sidesteps the `src/workflow.ts` "valid factory function"
// trap — the alias always points at the real factory file).

/** Re-export the lazy registry (typed) for tests/inspectors. */
export interface LazySettings {
  lazyExtensions?: Record<string, string>;
}
const lazySettings: LazySettings = settings;

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
      const ts = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
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
