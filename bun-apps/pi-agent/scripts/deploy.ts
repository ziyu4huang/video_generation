/**
 * deploy — package pi-agent + its run-dir extension set into a SELF-CONTAINED,
 * runnable directory that works from ANY cwd.
 *
 * WHY THIS EXISTS
 *   `build.ts` bundles pi-agent into `dist/pi-agent/pi-agent.js`, but that
 *   bundle still resolves its extension set from the REPO's `bun-apps/` (baked
 *   into `src/generated/run-dir-base.ts` at build time). So it only runs where
 *   that repo path exists. `deploy.ts` closes that gap: it copies the extension
 *   packages INTO the output dir as `packages/<pkg>/…` and `run-dir/manifest.json`,
 *   and `run-dir/resolve.ts`'s DEPLOY-PACKAGE mode detects that layout at
 *   runtime and resolves the manifest against `packages/` instead of the repo —
 *   so the result runs anywhere, with no repo checkout required (same machine).
 *
 * WHAT IT PRODUCES (flat — NO .pi/)
 *   <outdir>/
 *   ├── pi-agent.js            # bundle (copied from dist/pi-agent/)
 *   ├── run-dir/manifest.json  # the extension/skill/npm set (resolve.ts reads this)
 *   ├── packages/<pkg>/…       # copied extension packages
 *   ├── package.json           # workspaces root + npm-ext deps
 *   ├── node_modules/          # wired by `bun install`
 *   └── run.sh                 # layout-aware launcher
 *
 *   run-dir/resolve.ts, in deploy-package mode, injects `-ne` + `-e <pkg paths>`
 *   so the package is self-contained: pi loads ONLY these paths and ignores any
 *   <cwd>/.pi/ (avoids cross-path conflicts when run inside a repo declaring the
 *   same extensions). Source/repo-bundle modes stay additive (no -ne).
 *
 * USAGE
 *   bun scripts/deploy.ts [options] [out-dir]
 *     --no-build    reuse existing dist/pi-agent/pi-agent.js
 *     --no-install  skip `bun install` in out-dir
 *     --keep        (none — out-dir is the package)
 *   Default out-dir: ../../dist/pi-agent-deploy
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
if (argv.some((a) => a === "-h" || a === "--help")) {
  console.log((await Bun.file(import.meta.path).text()).split("*/")[0].replace(/^\/\*\*?|\*\/?$/gm, "").trim());
  process.exit(0);
}
const NO_BUILD = argv.includes("--no-build");
const NO_INSTALL = argv.includes("--no-install");
const OUTDIR = resolve(process.cwd(), argv.find((a) => !a.startsWith("-")) ?? "../../dist/pi-agent-deploy");

const piAgentDir = dirname(import.meta.dir); // bun-apps/pi-agent
const repoRoot = dirname(dirname(piAgentDir));
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
function die(msg: string): never { console.error(R(`error: ${msg}`)); process.exit(1); }
function readJson<T>(p: string): T | null { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } }

// ── manifest = the single source of truth for what to bundle ─────────────────
const manifestPath = join(piAgentDir, "run-dir", "manifest.json");
const manifest = readJson<{ extensions?: string[]; skills?: string[]; npmExtensions?: { pkg: string; entry: string }[] }>(manifestPath);
if (!manifest) die(`run-dir/manifest.json not found at ${manifestPath}`);

// Collect the package DIR names to copy (top-level segment of each ext/skill path).
const pkgDirs = new Set<string>();
for (const rel of [...(manifest.extensions ?? []), ...(manifest.skills ?? [])]) {
  const seg = rel.split("/")[0];
  if (seg) pkgDirs.add(seg);
}
if (pkgDirs.size === 0) die("manifest lists no extensions/skills to bundle.");

// ── build bundle ─────────────────────────────────────────────────────────────
const bundleSrc = join(repoRoot, "dist", "pi-agent", "pi-agent.js");
if (!NO_BUILD || !existsSync(bundleSrc)) {
  console.log(`${G("▶")} build bundle  ${D("(bun scripts/build.ts)")}`);
  const b = Bun.spawn(["bun", "scripts/build.ts"], { cwd: piAgentDir, stdout: "inherit", stderr: "inherit" });
  if ((await b.exited) !== 0) die("build.ts failed");
} else {
  console.log(`${G("▶")} build bundle  ${D("(skipped --no-build)")}`);
}
if (!existsSync(bundleSrc)) die(`bundle missing: ${bundleSrc}`);

// ── materialize out-dir ──────────────────────────────────────────────────────
console.log(`${G("▶")} out-dir  ${D(OUTDIR)}`);
if (existsSync(OUTDIR)) rmSync(OUTDIR, { recursive: true });
mkdirSync(join(OUTDIR, "packages"), { recursive: true });
mkdirSync(join(OUTDIR, "run-dir"), { recursive: true });

cpSync(bundleSrc, join(OUTDIR, "pi-agent.js"));
cpSync(manifestPath, join(OUTDIR, "run-dir", "manifest.json"));

// launcher
const runSh = join(piAgentDir, "run.sh");
if (existsSync(runSh)) { cpSync(runSh, join(OUTDIR, "run.sh")); chmodSync(join(OUTDIR, "run.sh"), 0o755); }

// copy each package (skip node_modules/dist/.git)
const SKIP = new Set(["node_modules", "dist", ".git", "__tests__"]);
for (const dir of [...pkgDirs].sort()) {
  const src = join(repoRoot, "bun-apps", dir);
  if (!existsSync(src)) { console.log(`${Y("·")} skip missing ${dir}`); continue; }
  cpSync(src, join(OUTDIR, "packages", dir), {
    recursive: true,
    filter: (s) => !SKIP.has(basename(dirname(s))) || basename(s) === "",
  });
  console.log(`    ${G("✓")} ${dir}  ${D("(copied)")}`);
}

// ── workspace root package.json (workspaces + npm-ext deps) ──────────────────
// Aggregate external deps across packages + the npm extensions, so `bun install`
// links them from the global store. Workspace peers resolve internally.
const rootDeps: Record<string, string> = {};
const localNames = new Set(pkgDirs);
for (const dir of pkgDirs) {
  const m = readJson<any>(join(repoRoot, "bun-apps", dir, "package.json"));
  if (!m) continue;
  // register by package.json name too (for peer lookups below)
  for (const f of ["dependencies", "peerDependencies"] as const) {
    for (const [dep, ver] of Object.entries<any>(m[f] ?? {})) {
      if (!localNames.has(dep) && !pkgDirs.has(dep) && !rootDeps[dep]) rootDeps[dep] = String(ver);
    }
  }
}
for (const { pkg } of manifest.npmExtensions ?? []) rootDeps[pkg] = "latest";
if (!rootDeps["@earendil-works/pi-coding-agent"]) rootDeps["@earendil-works/pi-coding-agent"] = "latest";
writeFileSync(
  join(OUTDIR, "package.json"),
  JSON.stringify({ name: "pi-agent-deploy", private: true, type: "module", workspaces: ["packages/*"], dependencies: rootDeps }, null, 2) + "\n",
);

// ── bun install ──────────────────────────────────────────────────────────────
if (!NO_INSTALL) {
  console.log(`${G("▶")} bun install  ${D(`(cwd: ${OUTDIR})`)}`);
  const p = Bun.spawn(["bun", "install"], { cwd: OUTDIR, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) die("bun install failed");
} else {
  console.log(`${Y("·")} bun install skipped (--no-install)`);
}

// ── done ─────────────────────────────────────────────────────────────────────
console.log(`\n${G("✓ deployed")} → ${OUTDIR}`);
console.log(D(`    ${OUTDIR}/pi-agent.js --list-models   # smoke test`));
console.log(D(`    ${OUTDIR}/pi-agent.js -p "hello"      # print mode (any cwd)`));
