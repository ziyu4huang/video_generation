/**
 * deploy — package pi-agent + a whitelisted set of extension packages into a
 * self-contained, runnable directory that works from ANY cwd.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  THE FIVE THINGS THAT MUST STAY TRUE (read this first)
 * ════════════════════════════════════════════════════════════════════════
 *
 *  1. SELF-CONTAINED — decoupled from the repo's `.pi/`.
 *     This script must pack from the WORKSPACE alone, not from
 *     `.pi/settings.json`. It finds the workspace root by walking up from its
 *     own location for a `package.json` with `workspaces` next to a `bun-apps/`
 *     dir (`findWorkspaceRoot()`), falling back to `findPiRepoRoot()` only if
 *     that fails. Deleting the entire repo `.pi/` (settings, workflows,
 *     benchmarks, vault config) does NOT break packing — verified.
 *
 *  2. WHITELIST is the package's extension set. Resolution order (first wins):
 *       (a) `--only a,b,c`               CLI override
 *       (b) `deploy.config.json`          { "extensions": [...] } next to script
 *       (c) all `bun-apps/*` packages     that have an `extensions/` dir (default)
 *     `.pi/settings.json` is consulted only as an EXTRA source and for `npm:`
 *     registry carryover — both no-op when absent. Transitive local workspace
 *     peers are auto-included (e.g. pi-knowledge-card → pi-obsidian) so
 *     bare-specifier imports resolve.
 *
 *  3. RUNTIME EXTENSION LOADING is NOT done here — it's done by
 *     `src/deploy-mode.ts` at the start of `cli.ts`. It detects the deploy
 *     layout (sentinel `.pi-deploy-marker.json`) and injects
 *     `-ne` + `-e <abs-ext-paths>` into argv. The `-ne` is ESSENTIAL: pi's
 *     `resource-loader.js` does `noExtensions ? cliPaths : merge(cliPaths,
 *     settingsPaths)` — without `-ne`, running inside a repo that declares the
 *     SAME extensions loads both sets → `Tool "X" conflicts with …`. `-e` is
 *     `temporary` scope, so it's trust-free and cwd-independent. This is the
 *     bug that bit us twice; `-ne` is the fix. (Full story: docs/deploy-cwd-trust.md)
 *
 *  4. ONE LAYOUT-AWARE LAUNCHER — `run.sh` is copied into every package and
 *     auto-detects its layout (the SAME script works in both places):
 *       • `pi-agent.js` + `.pi-deploy-marker.json` present → `bun pi-agent.js` (deployed)
 *       • else `src/cli.ts` present                       → `bun src/cli.ts` (source/dev)
 *     The chosen entry selects the right node_modules context automatically.
 *
 *  5. VERIFY BEFORE TRUSTING (hard-won lessons — see docs/deploy-cwd-trust.md):
 *       • Test from a FOREIGN cwd, not only from inside the package
 *         (cwd-coupled bugs are invisible when cwd == artifact).
 *       • Test against a REAL installed repo declaring the SAME extensions,
 *         not a dummy package — only a real extension surfaces conflicts.
 *       • Rebuild (`scripts/build.ts`) BEFORE redeploying — editing source
 *         does NOT update an already-deployed `pi-agent.js` bundle.
 *       • Verify tool registration via a probe extension dumping
 *         `pi.getAllTools()` names + `sourceInfo.path` to stderr on
 *         `session_start` — NOT the model's self-report in `-p` mode.
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *   `build.ts` only bundles pi-agent itself. The resulting `pi-agent.js`
 *   still needs the surrounding monorepo to load extensions at runtime.
 *   `deploy.ts` closes that gap: it produces a single directory you can run
 *   `bun pi-agent.js` (or `./run.sh`) from with a curated extension set baked
 *   in — no repo checkout required (modulo the absolute PI_PKG_DIR baked into
 *   the bundle; see "Portability" below).
 *
 * WHAT IT PRODUCES
 *   <outdir>/
 *   ├── pi-agent.js            # bundle (copied from dist/pi-agent/)
 *   ├── pi-agent.js.map        # sourcemap (debug only)
 *   ├── run.sh                 # layout-aware launcher (source + deployed)
 *   ├── package.json           # workspace root: workspaces + aggregated deps
 *   ├── .pi/settings.json      # generated: whitelisted packages as ../packages/<name>
 *   ├── packages/<name>/…      # copied (or symlinked) extension packages
 *   ├── node_modules/          # wired by `bun install` in <outdir>
 *   ├── .pi-deploy-marker.json # sentinel consumed by src/deploy-mode.ts
 *   └── README.md              # how to run
 *
 * USAGE
 *   bun scripts/deploy.ts [options] [out-dir]
 *
 *   Options:
 *     --only <a,b,c>      only these package names (overrides config file)
 *     --with <pkg=dir>    extra local package to add, by name=path
 *     --no-build          reuse existing dist/pi-agent/pi-agent.js
 *     --no-install        skip `bun install` in out-dir
 *     --no-npm            drop npm: registry entries from settings
 *     --symlink-pkgs      symlink packages/* → source instead of copying
 *     -h, --help          print this header
 *
 *   Default out-dir: ../../dist/pi-agent-deploy
 *
 * PORTABILITY
 *   The bundle embeds an absolute PI_PKG_DIR (see scripts/build.ts stage 0)
 *   pointing at the repo's pi-coding-agent for theme/asset resolution. So the
 *   produced dir is portable across machines ONLY if that absolute path exists
 *   on the target. For same-machine relocations (incl. /tmp test dirs) it just
 *   works. For fully portable builds, rebuild on the target machine.
 *
 * Run from anywhere — the script resolves the workspace root from its own location.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findPiRepoRoot } from "../src/preflight.ts"; // also used as a fallback for npm-settings carryover

// ── argv ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.some((a) => a === "-h" || a === "--help")) {
  const src = await Bun.file(import.meta.path).text();
  const header = src.split("*/")[0].replace(/^\/\*\*?|\*\/?$/gm, "").trim();
  console.log(header);
  process.exit(0);
}

const OPTS = {
  only: popFlag("--only")?.split(",").map((s) => s.trim()).filter(Boolean),
  with: popFlagValues(/^--with=(.+)$/, /^--with$/, "value"),
  noBuild: argv.includes("--no-build"),
  noInstall: argv.includes("--no-install"),
  noNpm: argv.includes("--no-npm"),
  symlinkPkgs: argv.includes("--symlink-pkgs"),
};
const OUTDIR = resolve(process.cwd(), argv[0] ?? "../../dist/pi-agent-deploy");

// mutates argv as it consumes known flags; positional remainder = out-dir
function popFlag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
function popFlagValues(eq: RegExp, plain: RegExp, _label: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; ) {
    const a = argv[i];
    const mEq = a.match(eq);
    if (mEq) {
      out.push(mEq[1]);
      argv.splice(i, 1);
      continue;
    }
    if (plain.test(a) && i + 1 < argv.length) {
      out.push(argv[i + 1]);
      argv.splice(i, 2);
      continue;
    }
    i++;
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
function die(msg: string): never {
  console.error(R(`error: ${msg}`));
  process.exit(1);
}
function readJson<T = unknown>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// ── repo root ────────────────────────────────────────────────────────────────
// The deploy artifact must be buildable from the workspace alone (whitelist
// comes from deploy.config.json / --only, packages from bun-apps/*), so we do
// NOT require .pi/settings.json to exist. Find the workspace root by walking
// up from this script's location for a package.json with `workspaces` next to
// a bun-apps/ directory.
function hasWorkspacesRoot(pkgJsonPath: string): boolean {
  const m = readJson<any>(pkgJsonPath);
  return Array.isArray(m?.workspaces) || (typeof m?.workspaces === "object" && m.workspaces !== null);
}
function findWorkspaceRoot(): string | null {
  let cur = dirname(import.meta.dir); // bun-apps/pi-agent
  for (;;) {
    if (existsSync(join(cur, "bun-apps")) && hasWorkspacesRoot(join(cur, "package.json"))) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
const repoRoot = findWorkspaceRoot() ?? findPiRepoRoot();
if (!repoRoot) {
  die("not a pi-agent workspace (no package.json with workspaces + bun-apps/).");
}

// ── 1. discover local packages ───────────────────────────────────────────────
// All local workspace packages: name → abs dir. Sourced from .pi/settings.json
// local entries plus a bun-apps/* scan so --with / --only can address any.
interface PkgInfo {
  name: string;
  dir: string;
  manifest: any;
}
const byName = new Map<string, PkgInfo>();
function registerPackage(dir: string) {
  const m = readJson<any>(join(dir, "package.json"));
  if (!m?.name) return;
  byName.set(m.name, { name: m.name, dir, manifest: m });
}
{
  const settings = readJson<{ packages?: string[] }>(
    join(repoRoot, ".pi", "settings.json"),
  );
  for (const entry of settings?.packages ?? []) {
    if (entry.startsWith("npm:") || entry.startsWith("@")) continue;
    registerPackage(resolve(join(repoRoot, ".pi"), entry));
  }
  // also scan bun-apps/* so names not in settings are addressable
  const appsDir = join(repoRoot, "bun-apps");
  if (existsSync(appsDir)) {
    for (const e of readdirSync(appsDir, { withFileTypes: true })) {
      if (e.isDirectory()) registerPackage(join(appsDir, e.name));
    }
  }
}
// extra --with name=path
for (const w of OPTS.with) {
  const [name, dir] = w.split("=");
  if (!name || !dir) die(`--with expects name=path, got "${w}"`);
  if (!existsSync(resolve(dir))) die(`--with path not found: ${dir}`);
  byName.set(name, { name, dir: resolve(dir), manifest: readJson(join(resolve(dir), "package.json")) ?? {} });
}

// ── 2. resolve whitelist (+ transitive local peers) ──────────────────────────
const configPath = join(dirname(import.meta.dir), "deploy.config.json");
const config = readJson<{ extensions?: string[] }>(configPath);
const explicit = OPTS.only ?? config?.extensions;
const allLocalNames = [...byName.values()]
  .filter((p) => hasExtensionsDir(p.dir))
  .map((p) => p.name);
const whitelist = explicit
  ? explicit
  : allLocalNames;

if (whitelist.length === 0) {
  die(
    "no extension packages selected. Use --only <names>, deploy.config.json, " +
      "or ensure .pi/settings.json lists local packages with extensions/.",
  );
}

// expand transitive local workspace peers so bare-specifier imports resolve
const ordered: string[] = [];
const seen = new Set<string>();
function visit(name: string, via: string) {
  if (seen.has(name)) return;
  const info = byName.get(name);
  if (!info) die(`${via}: unknown package "${name}" (not a workspace pkg).`);
  seen.add(name);
  const peers = {
    ...(info.manifest.dependencies ?? {}),
    ...(info.manifest.peerDependencies ?? {}),
  };
  for (const dep of Object.keys(peers)) {
    if (byName.has(dep) && dep !== name) visit(dep, `peer of ${name}`);
  }
  ordered.push(name); // deps first → install-friendly ordering
}
for (const n of whitelist) visit(n, "whitelist");

console.log(`${G("▶")} whitelist (${whitelist.length}) + peers (${ordered.length - whitelist.length})`);
for (const n of ordered) {
  const tag = whitelist.includes(n) ? D("whitelist") : D("auto-peer");
  console.log(`    ${n}  ${tag}`);
}

// ── 3. ensure bundle is built ────────────────────────────────────────────────
const bundleSrc = resolve(repoRoot, "dist", "pi-agent", "pi-agent.js");
const mapSrc = `${bundleSrc}.map`;
if (!OPTS.noBuild || !existsSync(bundleSrc)) {
  console.log(`${G("▶")} build bundle  ${D("(bun scripts/build.ts)")}`);
  const proc = Bun.spawn(["bun", "scripts/build.ts"], {
    cwd: dirname(import.meta.dir),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) die(`build.ts exited ${code}`);
} else {
  console.log(`${G("▶")} build bundle  ${D("(skipped --no-build)")}`);
}
if (!existsSync(bundleSrc)) die(`bundle missing after build: ${bundleSrc}`);

// ── 4. materialize out-dir ───────────────────────────────────────────────────
console.log(`${G("▶")} out-dir  ${D(OUTDIR)}`);
if (existsSync(OUTDIR)) {
  rmSync(OUTDIR, { recursive: true });
}
mkdirSync(join(OUTDIR, "packages"), { recursive: true });
mkdirSync(join(OUTDIR, ".pi"), { recursive: true });

// copy bundle
cpSync(bundleSrc, join(OUTDIR, "pi-agent.js"));
if (existsSync(mapSrc)) cpSync(mapSrc, join(OUTDIR, "pi-agent.js.map"));

// copy the launcher so the SAME run.sh works in the deployed dir (it
// auto-detects the bundle layout and runs pi-agent.js).
const runSh = join(dirname(import.meta.dir), "run.sh");
if (existsSync(runSh)) {
  cpSync(runSh, join(OUTDIR, "run.sh"));
  chmodSync(join(OUTDIR, "run.sh"), 0o755);
}

// copy/symlink each package (skip node_modules, dist, tests, .git)
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__tests__"]);
for (const name of ordered) {
  const info = byName.get(name)!;
  const dst = join(OUTDIR, "packages", name);
  if (OPTS.symlinkPkgs) {
    symlinkSync(info.dir, dst);
    console.log(`    ${G("→")} ${name}  ${D("(symlink)")}`);
  } else {
    cpSync(info.dir, dst, {
      recursive: true,
      filter: (s) => !SKIP_DIRS.has(basename(dirname(s))) || basename(s) === "",
    });
    console.log(`    ${G("✓")} ${name}  ${D("(copied)")}`);
  }
}

// ── 5. workspace root package.json ───────────────────────────────────────────
// Aggregate external deps across packages so `bun install` links them from the
// global store. Workspace peers resolve internally (workspace:*).
const rootDeps: Record<string, string> = {};
const localNames = new Set(ordered);
for (const name of ordered) {
  const m = byName.get(name)!.manifest;
  for (const depField of ["dependencies", "peerDependencies"] as const) {
    for (const [dep, ver] of Object.entries<any>(m[depField] ?? {})) {
      if (localNames.has(dep)) continue; // workspace-internal
      // first-seen wins; "*" / "latest" keep verbatim, bun resolves from store
      if (!rootDeps[dep]) rootDeps[dep] = String(ver);
    }
  }
}
// pi-coding-agent must be present for any extension importing the pi API.
if (!rootDeps["@earendil-works/pi-coding-agent"]) {
  rootDeps["@earendil-works/pi-coding-agent"] = "latest";
}
const rootPkg = {
  name: "pi-agent-deploy",
  private: true,
  type: "module",
  workspaces: ["packages/*"],
  dependencies: rootDeps,
};
writeFileSync(join(OUTDIR, "package.json"), JSON.stringify(rootPkg, null, 2) + "\n");

// ── 6. .pi/settings.json ─────────────────────────────────────────────────────
// pi resolves project settings entries relative to <cwd>/.pi (package-manager.js:
// projectBaseDir = join(cwd, CONFIG_DIR_NAME)), so the entry must climb out of
// .pi to reach <pkg>/packages/<name>.
const settingsPkgs: string[] = ordered.map((n) => `../packages/${n}`);
if (!OPTS.noNpm) {
  // Carry over registry packages ("npm:<name>") verbatim — they resolve from
  // node_modules once `bun install` runs.
  const settings = readJson<{ packages?: string[] }>(
    join(repoRoot, ".pi", "settings.json"),
  );
  for (const e of settings?.packages ?? []) {
    if (e.startsWith("npm:")) settingsPkgs.push(e);
  }
}
writeFileSync(
  join(OUTDIR, ".pi", "settings.json"),
  JSON.stringify({ packages: settingsPkgs }, null, 2) + "\n",
);

// ── 7. bun install ───────────────────────────────────────────────────────────
if (!OPTS.noInstall) {
  console.log(`${G("▶")} bun install  ${D(`(cwd: ${OUTDIR})`)}`);
  const proc = Bun.spawn(["bun", "install"], {
    cwd: OUTDIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) die(`bun install exited ${code}`);
} else {
  console.log(`${Y("·")} bun install skipped (--no-install)`);
}

// ── 8. filter npm entries to installed + write deploy marker ────────────────
// `npm:<name>` entries in settings.json are only loadable in cd-in mode if
// the package actually resolved into node_modules. Drop any that didn't (they
// would make pi error on startup). The deployed binary loads local baked
// extensions via -e regardless of cwd (see src/deploy-mode.ts), so this only
// affects the cd-in / settings path.
{
  const installed = existsSync(join(OUTDIR, "node_modules"))
    ? new Set(listTopLevelPackages(join(OUTDIR, "node_modules")))
    : new Set<string>();
  const cur = readJson<{ packages?: string[] }>(join(OUTDIR, ".pi", "settings.json"));
  const filtered = (cur?.packages ?? []).filter((e) => {
    if (!e.startsWith("npm:")) return true;
    const name = e.slice(4);
    return installed.has(name);
  });
  writeFileSync(
    join(OUTDIR, ".pi", "settings.json"),
    JSON.stringify({ packages: filtered }, null, 2) + "\n",
  );
  const dropped = (cur?.packages ?? []).filter((e) => !filtered.includes(e));
  if (dropped.length) {
    console.log(`${Y("·")} dropped uninstalled npm packages from settings: ${dropped.join(", ")}`);
  }
}
// Sentinel consumed by src/deploy-mode.ts to recognize a deploy layout.
writeFileSync(
  join(OUTDIR, ".pi-deploy-marker.json"),
  JSON.stringify(
    {
      deploy: true,
      generatedBy: "bun-apps/pi-agent/scripts/deploy.ts",
      generatedAt: new Date().toISOString(),
      whitelist,
      extensions: ordered,
    },
    null,
    2,
  ) + "\n",
);

// ── 9. README ────────────────────────────────────────────────────────────────
writeFileSync(join(OUTDIR, "README.md"), deployReadme(ordered, whitelist));

// ── done ─────────────────────────────────────────────────────────────────────
console.log("");
console.log(G("✓ deployed") + ` → ${OUTDIR}`);
console.log("");
console.log("  run from anywhere:");
console.log(D(`    ${OUTDIR}/pi-agent.js --list-models   # smoke test`));
console.log(D(`    ${OUTDIR}/pi-agent.js                 # interactive TUI`));
console.log(D(`    ${OUTDIR}/pi-agent.js -p "hello"      # print mode`));
console.log("  or cd in first (same effect): cd " + D(OUTDIR));

// ── helpers (deps) ───────────────────────────────────────────────────────────
function listTopLevelPackages(nmDir: string): string[] {
  const out: string[] = [];
  try {
    for (const e of readdirSync(nmDir, { withFileTypes: true })) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name.startsWith("@")) {
        try {
          for (const sub of readdirSync(join(nmDir, e.name), { withFileTypes: true })) {
            if (sub.isDirectory() || sub.isSymbolicLink()) out.push(`${e.name}/${sub.name}`);
          }
        } catch {
          /* ignore scoped read errors */
        }
        continue;
      }
      out.push(e.name);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function hasExtensionsDir(dir: string): boolean {
  const piField = readJson<any>(join(dir, "package.json"))?.pi;
  if (Array.isArray(piField?.extensions) && piField.extensions.length) return true;
  return existsSync(join(dir, "extensions"));
}

function deployReadme(all: string[], wl: string[]): string {
  const wlSet = new Set(wl);
  const lines = [
    "# pi-agent (deployed package)",
    "",
    "A self-contained, runnable pi-agent with a curated set of extensions.",
    "Produced by `bun-apps/pi-agent/scripts/deploy.ts`.",
    "",
    "## Run",
    "",
    "```bash",
    "cd " + OUTDIR,
    "",
    "bun pi-agent.js --list-models   # smoke test",
    "bun pi-agent.js                 # interactive TUI",
    'bun pi-agent.js -p "hello"      # print mode',
    "```",
    "",
    "## Contents",
    "",
    "| path | purpose |",
    "|------|---------|",
    "| `pi-agent.js` | bundled pi-agent (built by `scripts/build.ts`) |",
    "| `packages/<name>/` | extension packages (whitelist + auto peers) |",
    "| `.pi/settings.json` | the extension manifest pi loads at startup |",
    "| `package.json` | workspace root — `workspaces: [\"packages/*\"]` |",
    "| `node_modules/` | wired by `bun install` (global store cache) |",
    "",
    "## Extensions included",
    "",
    "| package | source |",
    "|---------|--------|",
  ];
  for (const n of all) {
    lines.push(`| \`${n}\` | ${wlSet.has(n) ? "whitelist" : "auto peer"} |`);
  }
  lines.push(
    "",
    "## Re-configuring the whitelist",
    "",
    "Edit `bun-apps/pi-agent/deploy.config.json` (`extensions` array) or pass",
    "`--only name1,name2` to `scripts/deploy.ts`, then redeploy.",
    "",
    "## Portability note",
    "",
    "`pi-agent.js` embeds an absolute `PI_PACKAGE_DIR` for theme/asset",
    "resolution. This package is portable across paths on the **same machine**.",
    "For a different machine, rebuild (`scripts/build.ts`) there first.",
    "",
  );
  return lines.join("\n");
}
