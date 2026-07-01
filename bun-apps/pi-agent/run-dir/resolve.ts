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
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.json";
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

  // DEPLOY-PACKAGE mode: a self-contained package produced by scripts/deploy.ts
  // — the bundle sits next to its own `packages/<pkg>/…` tree + `run-dir/manifest.json`.
  // Resolve the manifest against packages/ (NOT the repo's bun-apps/, and NOT
  // the build-time-baked run-dir-base.ts, which points at the repo). Uses `-ne`
  // so the package is self-contained: pi loads ONLY these -e paths and ignores
  // any <cwd>/.pi/ — avoiding cross-path tool-name conflicts when the package is
  // run inside a repo that declares the same extensions from different paths.
  const selfDir = dirname(fileURLToPath(url));
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
