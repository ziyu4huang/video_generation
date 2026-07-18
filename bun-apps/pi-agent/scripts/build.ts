/**
 * Build pipeline for pi-agent.
 *
 * Tiers:
 *   bun scripts/build.ts            bundle + minify (NO sourcemap by default)
 *   bun scripts/build.ts --sourcemap also emit the external sourcemap (.map)
 *   bun scripts/build.ts --compile  bun --compile → standalone executable
 *   bun scripts/build.ts --all      bundle + compile
 *
 * Sourcemap is OPT-IN: the .map embeds full original source (~20 MB) and is
 * never shipped — deploy.ts only copies pi-agent.js. Emitting it bloats dist/,
 * slows the build, and served no runtime purpose. Pass --sourcemap when you
 * need it for debugging the bundle in place.
 *
 * Output (repo root dist/, namespaced):
 *   ../../dist/pi-agent/pi-agent.js      bundled entry (minified)
 *   ../../dist/pi-agent/pi-agent.js.map  sourcemap (ONLY with --sourcemap)
 *   ../../dist/pi-agent/pi-agent         standalone executable (--compile only)
 *   ../../dist/pi-agent/theme/           asset dir copied alongside binary
 *   ../../dist/pi-agent/export-html/     asset dir copied alongside binary
 *   ../../dist/pi-agent/assets/          asset dir copied alongside binary
 *   ../../dist/pi-agent/node_modules     symlink → pi's bun-store deps (bundle)
 *
 * Three separate mechanisms, one per execution mode:
 *
 *   Bundle (.js): isBunBinary is false, so pi's extension loader takes the
 *   `alias: getAliases()` branch, which calls require.resolve("typebox") et al.
 *   relative to the bundle file. We (a) bake PI_PACKAGE_DIR into
 *   src/generated/pi-pkg-dir.ts for asset/theme resolution, and (b) symlink
 *   node_modules → pi's bun-store so the loader can resolve typebox +
 *   @earendil-works/* at runtime. Without the symlink, extensions importing
 *   typebox fail with "Cannot find package 'typebox'".
 *
 *   Binary: pi's isBunBinary flag is true → loader uses virtualModules
 *   (typebox supplied in-memory), and getPackageDir() = dirname(exe).
 *   We copy theme/, export-html/, and assets/ alongside the exe. No symlink
 *   needed — virtualModules needs no filesystem resolution.
 *
 *   Source (`bun src/cli.ts`): no build step. pi resolves everything via the
 *   real node_modules tree; the set-package-dir patch skips entirely.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import manifest from "../run-dir/manifest.json";

const APP_NAME: string = basename(process.cwd()); // "pi-agent"
const ENTRY = "src/cli.ts";
const GENERATED_DIR = "src/generated";
const GENERATED_PKG_DIR = `${GENERATED_DIR}/pi-pkg-dir.ts`;
const GENERATED_RUN_DIR_BASE = `${GENERATED_DIR}/run-dir-base.ts`;

// Single source of truth for the npm-sourced extension set lives in
// run-dir/manifest.json (read by run-dir/resolve.ts at runtime too).
const NPM_EXTENSIONS = manifest.npmExtensions ?? [];

// Skill dirs shipped alongside the compiled binary for the statically-bundled
// "general productivity" extension set (src/static-extensions.ts). Single
// source of truth (manifest.json's binarySkills) shared with
// run-dir/resolve.ts's binary-mode --skill emission — keep the two in
// lockstep by construction (both read this field), not by convention.
const BINARY_SKILLS: string[] = manifest.binarySkills ?? [];

// pi-agent-ext-hermes-memory's src/store/vault-converge.ts has two OPTIONAL
// (try/catch-guarded) dynamic imports of pi-obsidian/pi-knowledge-card as
// LITERAL bare specifiers. Now that hermes-memory is a static import
// reachable from cli.ts's entrypoint (src/static-extensions.ts), Bun's
// bundler (splitting: false) would otherwise statically resolve + inline
// those two packages too (they're linked via hermes-memory's own
// devDependencies under the isolated linker) — silently blowing past the
// intended 5-extension scope. Marking them external leaves the two
// `await import("literal-specifier")` calls as genuine unresolved runtime
// imports, so vault-converge.ts's existing try/catch degrades gracefully
// (its original "optional integration if available" design) instead of the
// specifier resolving at build time. Glob-pattern precedent:
// scripts/build-extensions.ts's THIN_EXTERNALS.
const HERMES_OPTIONAL_EXTERNALS = [
	"@repo/pi-agent-ext-obsidian",
	"@repo/pi-agent-ext-obsidian/*",
	"@repo/pi-agent-ext-knowledge-card",
	"@repo/pi-agent-ext-knowledge-card/*",
];

const OUTDIR = resolve(process.cwd(), "..", "..", "dist", APP_NAME);
const OUTFILE = `${OUTDIR}/${APP_NAME}.js`;
const MAPFILE = `${OUTFILE}.map`;
const EXE = `${OUTDIR}/${APP_NAME}`;

const argv = process.argv.slice(2);
const DO_COMPILE = argv.includes("--compile") || argv.includes("--all");
// Sourcemap is opt-in (see file header): the .map is ~20 MB, embeds full source,
// and is never shipped (deploy.ts copies only pi-agent.js). Default off.
const WITH_SOURCEMAP = argv.includes("--sourcemap");

function ensureOutdir() {
  if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
  if (!existsSync(GENERATED_DIR)) mkdirSync(GENERATED_DIR, { recursive: true });
}

function clean(...files: string[]) {
  for (const f of files) if (existsSync(f)) rmSync(f, { recursive: true });
}

// ── Resolve pi-coding-agent package directory ─────────────────────────────────
// Bun resolves this relative to the build script's location (bun-apps/pi-agent/).
// The result is the absolute path to the pi-coding-agent package in node_modules.
function resolvePiPkgDir(): string {
  const pkgJsonUrl = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
  return dirname(new URL(pkgJsonUrl).pathname);
}

// ── Stage 0: generate PI_PKG_DIR constant ────────────────────────────────────
function stageGeneratePkgDir(piPkgDir: string) {
  console.log(`▶ generate src/generated/pi-pkg-dir.ts`);
  ensureOutdir();
  writeFileSync(
    GENERATED_PKG_DIR,
    `// AUTO-GENERATED by scripts/build.ts — do not edit or commit\n` +
    `// Points the set-package-dir patch at the real pi-coding-agent in node_modules.\n` +
    `export const PI_PKG_DIR = ${JSON.stringify(piPkgDir)};\n`,
  );
  console.log(`  ✓ PI_PKG_DIR = ${piPkgDir}`);
}

// ── Stage 0b: generate run-dir base constants (BUN_APPS_DIR + npm ext paths) ──
// Same problem/pattern as stageGeneratePkgDir: bun rewrites import.meta.dir to
// the bundle output location, so run-dir/resolve.ts can't compute bun-apps/
// live once bundled. Bake it here, where process.cwd() reliably = pi-agent/
// (this build script is never itself bundled) and import.meta.resolve() sees
// the real node_modules tree.
function stageGenerateRunDirBase() {
  console.log(`▶ generate src/generated/run-dir-base.ts`);
  ensureOutdir();
  const bunAppsDir = resolve(process.cwd(), "..");
  const npmExtensionPaths: string[] = [];
  for (const { pkg, entry } of NPM_EXTENSIONS) {
    try {
      const pkgJsonUrl = import.meta.resolve(`${pkg}/package.json`);
      const pkgDir = dirname(new URL(pkgJsonUrl).pathname);
      npmExtensionPaths.push(`${pkgDir}/${entry}`);
    } catch {
      console.log(`  · skipping npm extension "${pkg}" (not resolvable — is it installed?)`);
    }
  }
  writeFileSync(
    GENERATED_RUN_DIR_BASE,
    `// AUTO-GENERATED by scripts/build.ts — do not edit or commit\n` +
    `// Bakes absolute paths for run-dir/resolve.ts's bundle-mode branch.\n` +
    `export const BUN_APPS_DIR = ${JSON.stringify(bunAppsDir)};\n` +
    `export const NPM_EXTENSION_PATHS = ${JSON.stringify(npmExtensionPaths, null, 2)};\n`,
  );
  console.log(`  ✓ BUN_APPS_DIR = ${bunAppsDir}`);
  console.log(`  ✓ ${npmExtensionPaths.length} npm extension path(s) resolved`);
}

// ── Stage 1: bundle + minify ─────────────────────────────────────────────────
async function stageBundle() {
  console.log(`▶ bundle + minify → dist/${APP_NAME}/${APP_NAME}.js`);
  clean(OUTFILE, MAPFILE, EXE);

  const { build } = await import("bun");
  const result = await build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    target: "bun",
    format: "esm",
    naming: `${APP_NAME}.js`,
    minify: { whitespace: true, identifiers: true, syntax: true },
    sourcemap: WITH_SOURCEMAP ? "external" : "none",
    splitting: false,
    external: HERMES_OPTIONAL_EXTERNALS,
  });

  if (!result.success) {
    for (const l of result.logs) console.error(l);
    process.exit(1);
  }

  // Only append the sourceMappingURL comment when a map was actually emitted;
  // otherwise the comment points at a nonexistent file.
  if (WITH_SOURCEMAP) {
    appendFileSync(OUTFILE, `\n//# sourceMappingURL=${APP_NAME}.js.map\n`);
  }
  console.log(`  ✓ ${OUTFILE}  (${formatSize(OUTFILE)})`);
  console.log(`  ✓ ${MAPFILE}`);
}

// ── Stage 2: symlink node_modules for extension runtime resolution ───────────
// The bundle inlines pi-coding-agent, but extensions are .ts files loaded at
// runtime via jiti. In bundle mode isBunBinary is false, so pi's loader calls
// getAliases() → require.resolve("typebox") / import.meta.resolve("@earendil-works/...")
// relative to the bundle file. Those bare specifiers resolve from the bundle's
// nearest node_modules — which doesn't exist under dist/pi-agent/. Symlinking
// to pi's bun-store node_modules (which holds typebox, jiti, and the
// @earendil-works/* workspace pkgs) makes getAliases resolve correctly.
//
// Binary mode does NOT need this: isBunBinary=true → virtualModules supplies
// these in-memory. We symlink unconditionally because the .js bundle always
// exists and it is harmless alongside the binary.
function stageLinkDeps(piPkgDir: string) {
  console.log(`▶ symlink dist/${APP_NAME}/node_modules → pi deps store`);
  // piPkgDir = <store-root>/node_modules/@earendil-works/pi-coding-agent
  //   → "../.." = <store-root>/node_modules  (typebox, jiti, @earendil-works/* …)
  const storeNodeModules = resolve(piPkgDir, "..", "..");
  const link = `${OUTDIR}/node_modules`;
  if (!existsSync(storeNodeModules)) {
    console.log(`  · skipping (deps store not found at ${storeNodeModules})`);
    return;
  }
  if (existsSync(link) || lstatSyncSafe(link)) rmSync(link, { recursive: true });
  symlinkSync(storeNodeModules, link);
  console.log(`  ✓ node_modules → ${storeNodeModules}`);
}

function lstatSyncSafe(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// ── Stage 2: compile to standalone executable ─────────────────────────────────
async function stageCompile() {
  console.log(`▶ compile → dist/${APP_NAME}/${APP_NAME}  (standalone binary)`);
  clean(EXE);
  // stageCompile() is a SECOND, independent bundling pass over OUTFILE (not a
  // passthrough of stage 1's bundle) — re-apply the same --external exclusion
  // here, don't assume stage 1's `external` carries over.
  const externalFlags = HERMES_OPTIONAL_EXTERNALS.flatMap((p) => ["--external", p]);
  const proc = Bun.spawn(
    ["bun", "build", OUTFILE, "--compile", `--outfile=${EXE}`, "--minify", ...externalFlags],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`  ✗ bun build --compile exited ${code}`);
    process.exit(code);
  }
  console.log(`  ✓ ${EXE}  (${formatSize(EXE)})`);
}

// ── Stage 3: copy assets alongside the binary ────────────────────────────────
// pi's isBunBinary path expects these dirs next to the executable.
// getThemesDir()       → <exe-dir>/theme/
// getExportTemplateDir → <exe-dir>/export-html/
// getAssetsDir()       → <exe-dir>/assets/
function stageCopyAssets(piPkgDir: string) {
  console.log(`▶ copy pi assets alongside binary`);
  // bun-apps/ is the parent of process.cwd() (pi-agent/) — see
  // stageGenerateRunDirBase()'s identical resolve(process.cwd(), "..").
  const bunAppsDir = resolve(process.cwd(), "..");
  const assetMap: Array<[string, string]> = [
    [`${piPkgDir}/dist/modes/interactive/theme`, `${OUTDIR}/theme`],
    [`${piPkgDir}/dist/core/export-html`, `${OUTDIR}/export-html`],
    [`${piPkgDir}/dist/modes/interactive/assets`, `${OUTDIR}/assets`],
    // Skill dirs for the statically-bundled extension set (BINARY_SKILLS, read
    // from manifest.json's binarySkills — the same field run-dir/resolve.ts's
    // binary-mode branch reads to emit matching --skill <dst> paths).
    ...BINARY_SKILLS.map((rel): [string, string] => [`${bunAppsDir}/${rel}`, `${OUTDIR}/${rel}`]),
  ];
  for (const [src, dst] of assetMap) {
    if (!existsSync(src)) {
      console.log(`  · skipping ${basename(dst)}/ (not found in pi package)`);
      continue;
    }
    if (existsSync(dst)) rmSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
    console.log(`  ✓ ${basename(dst)}/`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(path: string): string {
  try {
    const bytes = Bun.file(path).size;
    if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
    return `${bytes} B`;
  } catch {
    return "?";
  }
}

// ── Pre-flight: workspace deps must be linked ──────────────────────────────
// A stale root `bun install` (or none at all) leaves `@repo/*` workspace deps
// un-symlinked in this package's node_modules. Bun's bundler then can't resolve
// their bare specifiers → either a hard build failure OR a silently broken
// bundle (depending on import site). Fail LOUDLY here with an actionable fix
// instead. Run `bun install` at the repo root, then rebuild.
function assertWorkspaceDeps(): void {
  const pj = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const all = { ...pj.dependencies, ...pj.peerDependencies };
  const ws = Object.keys(all).filter((d) => d.startsWith("@repo/"));
  const missing = ws.filter((d) => !existsSync(`node_modules/${d}`));
  if (missing.length > 0) {
    console.error(
      `\n✗ missing workspace symlinks: ${missing.join(", ")}\n` +
        `  The monorepo's node_modules is stale. Fix:\n` +
        `    bun install            # at the REPO ROOT (not here)\n` +
        `    bun scripts/build.ts   # then rebuild\n`,
    );
    process.exit(1);
  }
}

// ── Orchestrate ───────────────────────────────────────────────────────────────

assertWorkspaceDeps();
const piPkgDir = resolvePiPkgDir();
stageGeneratePkgDir(piPkgDir);
stageGenerateRunDirBase();
await stageBundle();
stageLinkDeps(piPkgDir);
if (DO_COMPILE) {
  await stageCompile();
  stageCopyAssets(piPkgDir);
}
// Keep the generated pi-pkg-dir.ts on disk (gitignored — machine-specific).
// Source mode never needs it: the set-package-dir patch loads it via a
// try/catch'd dynamic import and skips when the file is absent.

console.log("▶ done");
if (WITH_SOURCEMAP && existsSync(MAPFILE)) {
  console.log("");
  console.log("  ⚠  sourcemap present (you passed --sourcemap) — contains full original source.");
  console.log("     It is NOT shipped by deploy.ts. Remove if unwanted:  rm dist/pi-agent/pi-agent.js.map");
}
