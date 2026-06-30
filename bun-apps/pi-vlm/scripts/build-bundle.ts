/**
 * Bundle the pi-vlm extension into a single minified (and optionally
 * obfuscated) `.js` that can be loaded via `pi -e <bundle>.js`.
 *
 * WHY
 * ---
 * Shipping a `.ts` extension means shipping source. Bundling to one file lets
 * us minify + mangle identifiers (light obfuscation) so the shipped artifact
 * is not directly readable, while remaining a valid pi extension (ESM with a
 * default factory export that pi's jiti loader imports).
 *
 * USAGE
 * -----
 *   bun scripts/build-bundle.ts              # FULL bundle — inline all deps (default)
 *   bun scripts/build-bundle.ts --thin        # THIN bundle — keep peer deps external
 *   bun scripts/build-bundle.ts --obfuscate   # + javascript-obfuscator pass
 *   bun scripts/build-bundle.ts --out <path>  # override output path
 *   bun scripts/build-bundle.ts --sourcemap   # emit sourcemap (debug only)
 *   bun scripts/build-bundle.ts --no-verify   # skip the self-verify stage
 *
 * OUTPUT (repo-root dist/, consistent with dist/pi-agent/):
 *   ../../dist/pi-extensions/pi-vlm.bundle.js   (full, ~6.8 MB)
 *   ../../dist/pi-extensions/pi-vlm.thin.js     (thin, ~25 KB)   [--thin]
 *
 * LOAD (with the pi-agent bundle):
 *   bun ../../dist/pi-agent/pi-agent.js -ne \
 *     -e ../../dist/pi-extensions/pi-vlm.bundle.js -p "list your tools"
 *
 * FULL vs THIN
 * ------------
 * FULL inlines typebox + src/pipeline.ts + EVERY transitive dep (babel, the
 * @earendil-works/* graph, …) into one self-contained ESM file. Big (~6.8 MB)
 * but the inlined noise also dilutes the readable surface — mild obfuscation
 * by volume.
 *
 * THIN marks the 4 peer deps (typebox + the 3 @earendil-works/* packages) as
 * `external`, so only the project's OWN src/ is bundled (~25 KB, 270× smaller,
 * builds in ms). stageResolveExternals then REWRITES each surviving bare
 * specifier to an absolute file path (the same paths getAliases() in
 * pi-coding-agent/dist/core/extensions/loader.js computes at runtime). See the
 * THIN FIX block above stageResolveExternals for why this rewrite is mandatory.
 *
 *   Why thin over full? (1) 270× smaller; (2) MULTI-EXTENSION SHARING — every
 *   extension resolves typebox/@earendil-works/* to the SAME absolute path, so
 *   bun's native module cache dedupes them: all extensions SHARE one typebox
 *   instance. FULL inlines a SEPARATE copy per extension (and one in the host),
 *   so N full extensions = (N+1)× typebox+its ~6.5 MB babel dependency. Thin
 *   sidesteps that entire duplication. (3) typebox version coherence — thin
 *   uses the host's typebox, so extension and host can NEVER drift; a full
 *   extension baked at a different time can.
 *
 *   Thin trade-off: the baked absolute paths are MACHINE-SPECIFIC (bun store /
 *   cache layout), so the thin bundle is NOT a portable artifact — rebuild it
 *   on the target machine. This mirrors what the pi-agent bundle already does
 *   (bakes PI_PKG_DIR, symlinks node_modules to the bun store). Less
 *   obfuscation-by-volume than FULL (the 25 KB is mostly your own logic) — pair
 *   with --obfuscate for real source protection (cheap on 25 KB vs slow on 6.8 MB).
 *
 * NOTES
 * -----
 * - `--minify` already renames local identifiers (e.g. `var A56=Object.create`),
 *   which defeats casual reading. `--obfuscate` adds string-array + control-flow
 *   transforms via javascript-obfuscator; it is OPTIONAL because (a) that package
 *   is not a default dep, and (b) on a multi-MB FULL bundle it is slow and can
 *   significantly grow the file. On a THIN bundle it is fast and recommended.
 * - The self-verify stage (--no-verify to skip) runs static integrity checks on
 *   the output AND, when the pi-agent bundle is present, a live load test that
 *   asserts vlm_describe registers. See stageVerify.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const APP_NAME = "pi-vlm";
const ENTRY = "extensions/pi-vlm.ts";
const OUTDIR = resolve(process.cwd(), "..", "..", "dist", "pi-extensions");
const DEFAULT_OUTFILE = `${OUTDIR}/${APP_NAME}.bundle.js`;

// Peer deps kept external in --thin mode. These are exactly the bare specifiers
// pi-vlm imports that are NOT node: builtins or relative project source. After
// bundling, stageResolveExternals REWRITES each surviving bare specifier to an
// absolute file path (see THIN_FIX below) — that rewrite is what makes a thin
// bundle loadable under pi's jiti loader.
const THIN_EXTERNALS = [
  "typebox",
  "typebox/*",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/*",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-agent-core/*",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-coding-agent/*",
];

// node: builtins (bun minify strips the `node:` prefix, so we also list the
// bare forms) — these must NOT be rewritten to absolute paths.
const BUILTINS = new Set([
  "fs","os","path","url","child_process","http","https","crypto","stream",
  "util","buffer","events","net","tls","zlib","querystring","string_decoder",
]);

// Where the pi-agent bundle lives, for the live load test. Resolved from the
// script's cwd (bun-apps/pi-vlm/) → repo root → dist/pi-agent/.
const PI_AGENT_BUNDLE = resolve(process.cwd(), "..", "..", "dist", "pi-agent", "pi-agent.js");

const argv = process.argv.slice(2);
const DO_THIN = argv.includes("--thin");
const DO_OBFUSCATE = argv.includes("--obfuscate");
const DO_SOURCEMAP = argv.includes("--sourcemap");
const DO_VERIFY = !argv.includes("--no-verify");
const outFlagIdx = argv.indexOf("--out");
const OUTFILE = outFlagIdx >= 0
  ? argv[outFlagIdx + 1]
  : DO_THIN
    ? `${OUTDIR}/${APP_NAME}.thin.js`
    : DEFAULT_OUTFILE;

function formatSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ── Stage 1: bundle + minify ─────────────────────────────────────────────────
async function stageBundle() {
  const mode = DO_THIN ? "THIN (peer deps external + abs-resolved)" : "FULL (inline all deps)";
  console.log(`▶ bundle + minify [${mode}] → ${ENTRY}`);
  if (!existsSync(ENTRY)) {
    console.error(`  ✗ entry not found: ${ENTRY}`);
    process.exit(1);
  }
  mkdirSync(OUTDIR, { recursive: true });
  if (existsSync(OUTFILE)) rmSync(OUTFILE, { recursive: true });

  const { build } = await import("bun");
  const result = await build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    target: "bun",
    format: "esm",
    naming: basename(OUTFILE),
    minify: { whitespace: true, identifiers: true, syntax: true },
    sourcemap: DO_SOURCEMAP ? "external" : "none",
    splitting: false,
    ...(DO_THIN ? { external: THIN_EXTERNALS } : {}),
  });

  if (!result.success) {
    for (const l of result.logs) console.error(l);
    process.exit(1);
  }
  console.log(`  ✓ ${OUTFILE}  (${formatSize(Bun.file(OUTFILE).size)})`);
}

// ── Stage 1b (thin only): rewrite bare specifiers → absolute file paths ───────
// THIN FIX — why this is mandatory, not optional.
//
// pi loads every extension through jiti (createJiti + jiti.import, in
// pi-coding-agent/dist/core/extensions/loader.js). In bundle/dev mode jiti runs
// with `alias: getAliases()` and tryNative at its default. The decisive detail:
// jiti wraps any module that contains a BARE specifier (e.g. "typebox") in a
// `data:text/javascript;base64,<whole module>` package specifier to apply the
// alias transform, and bun rejects that wrapper with `NameTooLong` once the
// module exceeds a low-KB limit (~between 267 B and 3.2 KB; every real pi-vlm
// module is over). FULL dodges it by having ZERO bare imports (jiti loads it
// natively, no wrapper, no size limit).
//
// So a thin bundle that leaves "typebox"/"@earendil-works/*" as bare specifiers
// is unconditionally broken at the shipping location. The fix: pre-resolve each
// bare specifier to its absolute file path at BUILD time (the same paths
// getAliases() computes at runtime via require.resolve). The bundle then has
// only absolute-path + node: + relative imports → no bare specifiers → jiti
// loads it natively → no wrapper → no size limit. Verified end-to-end: the
// abs-resolved thin bundle loads via `pi-agent.js -e <thin>.js`, registers
// vlm_describe with all 9 params, runs the full pipeline.
//
// Bonus over FULL: every extension resolves "typebox" to the SAME absolute path
// → bun's native module cache dedupes → all extensions SHARE one typebox (FULL
// inlines a separate copy per extension). The multi-extension duplication the
// FULL design suffers simply does not occur.
//
// Trade-off: the baked paths are MACHINE-SPECIFIC (bun cache / store layout),
// so the bundle is not a portable artifact — rebuild on the target machine.
// This mirrors what the pi-agent bundle already does (bakes PI_PKG_DIR, symlinks
// node_modules to the bun store), so it is consistent with the existing model.
function resolveBareToAbs(spec: string): string | null {
  if (spec.startsWith("node:") || BUILTINS.has(spec)) return null; // leave builtins
  try { return require.resolve(spec); } catch {} // works for typebox + subpaths
  // @earendil-works/* main export: bare resolve hits the exports map; go via
  // package.json + main/exports entry (mirrors getAliases' packageIndex logic).
  try {
    const pjPath = require.resolve(`${spec}/package.json`);
    const pj = JSON.parse(readFileSync(pjPath, "utf8"));
    const dir = pjPath.replace(/\/package\.json$/, "");
    const entry = pj.exports?.["."]?.import || pj.exports?.["."] || pj.main || "index.js";
    return `${dir}/${String(entry).replace(/^\.\//, "")}`;
  } catch {}
  return null;
}

function stageResolveExternals() {
  if (!DO_THIN) return;
  console.log(`▶ resolve bare specifiers → absolute paths (thin fix)`);
  let code = readFileSync(OUTFILE, "utf8");
  const bare = new Set<string>();
  for (const m of code.matchAll(/(?:from|import\()\s*["']([^"'#.][^"'']*?)["']/g)) {
    bare.add(m[1]);
  }
  let resolved = 0;
  const unresolved: string[] = [];
  for (const spec of [...bare]) {
    const abs = resolveBareToAbs(spec);
    if (abs === null) continue; // builtin — leave as-is
    if (!abs) { unresolved.push(spec); continue; }
    code = code.replace(
      new RegExp(`(["'])${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g"),
      `"${abs}"`,
    );
    console.log(`  ${spec} → ${abs}`);
    resolved++;
  }
  if (unresolved.length) {
    console.error(`  ✗ could not resolve: ${unresolved.join(", ")}`);
    console.error(`    (add to THIN_EXTERNALS or teach resolveBareToAbs)`);
    process.exit(1);
  }
  writeFileSync(OUTFILE, code);
  console.log(`  ✓ ${resolved} bare specifier(s) resolved → ${OUTFILE}`);
}

// ── Stage 2 (optional): javascript-obfuscator pass ───────────────────────────
// Only runs with --obfuscate AND javascript-obfuscator installed. Uses a
// moderate preset — full controlFlowFlattening + stringArray on a multi-MB
// bundle is slow and bloating; tune OBFUSCATOR_OPTIONS if you need heavier.
async function stageObfuscate() {
  if (!DO_OBFUSCATE) return;
  console.log(`▶ obfuscate (javascript-obfuscator)`);
  let obf: any;
  try {
    obf = (await import("javascript-obfuscator")).default;
  } catch {
    console.error(
      "  · skipping — javascript-obfuscator not installed.\n" +
        "    Install with: bun add -d javascript-obfuscator",
    );
    return;
  }
  const code = await Bun.file(OUTFILE).text();
  const result = obf.obfuscate(code, {
    compact: true,
    identifierNamesGenerator: "hexadecimal",
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayThreshold: 0.75,
    // Leave controlFlowFlattening off by default — expensive on large bundles.
    selfDefending: false,
    target: "browser",
    ignoreImports: true, // preserve ESM import/export syntax
  });
  writeFileSync(OUTFILE, result.getObfuscatedCode());
  console.log(`  ✓ ${OUTFILE}  (${formatSize(Bun.file(OUTFILE).size)})`);
}

// ── Stage 3: self-verify reviewer ─────────────────────────────────────────────
// Runs AFTER bundle (+ obfuscate). Two tiers:
//
//   STATIC (always): inspect the output bytes for the invariants a valid pi
//   extension bundle must hold — ESM default factory export present, minify
//   actually applied, no dangling relative src refs / absolute repo paths
//   leaking the source tree, and (thin) the expected peer-dep bare imports
//   survived as externals. Cheap, deterministic, no external process.
//
//   LIVE (when dist/pi-agent/pi-agent.js exists): boot the real pi-agent
//   bundle with `-ne -e <bundle>` and assert vlm_describe registers. This is
//   the only check that proves runtime alias resolution + factory invocation
//   actually work end-to-end. Skipped (warned, not failed) when the host
//   bundle is absent — e.g. building the extension before the agent bundle.
//
// Any HARD failure exits 1 so CI / a bad edit can't ship a broken bundle
// silently. LIVE-skip and obfuscation-density notes are warnings only.
async function stageVerify() {
  if (!DO_VERIFY) return;
  console.log(`▶ self-verify`);
  const code = await Bun.file(OUTFILE).text();
  const bytes = Buffer.byteLength(code);
  const failures: string[] = [];
  const warnings: string[] = [];

  // V1 — default factory export survived bundling. pi's loader imports the
  // default export and calls it as `(api) => void`. Both `export default` and
  // the minified `registerTool` call should be present.
  if (!/export\s+default/.test(code) && !code.includes("default:")) {
    failures.push("no ESM default export found — pi loader cannot import this");
  }
  if (!code.includes("registerTool")) {
    failures.push("registerTool call missing — extension registers nothing");
  }

  // V2 — minify applied. Mangled identifiers look like `var XY=Object.create`
  // or `_5=(J,Q)=>`. If long descriptive names survive, --minify silently
  // regressed (wrong flag, target mismatch).
  const mangled = /\bvar\s+[A-Za-z0-9$_]{1,3}\s*=\s*Object\.(create|defineProperty)/.test(code);
  if (!mangled) {
    warnings.push(
      "no short-mangled identifiers detected — minify may not have applied " +
        "(re-check --minify / target)",
    );
  }

  // V3 — no source-tree leakage. A bundled+minified artifact must not retain
  // dangling `../src/...` relative imports (means a project file escaped
  // inlining) or absolute repo paths (leaks usernames / layout).
  const danglingSrc = code.match(/\.\.\/src\/[a-z][a-z0-9./-]*/gi);
  if (danglingSrc) {
    failures.push(`dangling relative src refs not inlined: ${[...new Set(danglingSrc)].slice(0, 5).join(", ")}`);
  }
  if (!DO_THIN && /\/Users\/[a-z]/i.test(code)) {
    warnings.push("absolute /Users/... path found in output — leaks local layout");
  }
  // (thin mode INTENTIONALLY embeds absolute dep paths — that's the fix; exempt)

  // V4 — size sanity. Full ~6.8MB, thin ~25KB. A 0-byte or implausibly tiny
  // output means the build silently produced an empty/stub file.
  const maxBytes = DO_THIN ? 500_000 : 15_000_000;
  const minBytes = DO_THIN ? 5_000 : 1_000_000;
  if (bytes < minBytes) {
    failures.push(`output ${formatSize(bytes)} below expected minimum ${formatSize(minBytes)} — likely a stub/empty build`);
  }
  if (bytes > maxBytes) {
    warnings.push(`output ${formatSize(bytes)} above expected ceiling ${formatSize(maxBytes)} — dep graph grew?`);
  }

  // V5 (thin only) — stageResolveExternals must have rewritten EVERY bare
  // specifier to an absolute path. A surviving bare non-builtin import would
  // re-trigger jiti's data-URL wrap → NameTooLong at load. So: zero bare
  // imports left, and typebox resolved to an absolute path.
  if (DO_THIN) {
    const bareLeft = [...code.matchAll(/(?:from|import\()\s*["']([^"'#.][^"'']*?)["']/g)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith("node:") && !BUILTINS.has(s) && !s.startsWith("/"));
    if (bareLeft.length) {
      failures.push(`thin: bare specifier(s) not resolved to abs path: ${[...new Set(bareLeft)].slice(0, 5).join(", ")}`);
    }
    if (!/from\s*"\/[^"]+typebox[^"]*"/.test(code) && !/import\(\s*"\/[^"]*typebox/.test(code)) {
      warnings.push("thin: no absolute-path typebox import found — did stageResolveExternals run?");
    }
  }

  // V6 (full only) — sanity that deps got inlined (no bare @earendil IMPORT
  // left). Match actual import/require syntax, NOT bare string presence: the
  // extension's missingDeps() helper legitimately contains the literal
  // "@earendil-works/pi-coding-agent" as a probe string.
  if (!DO_THIN) {
    const bareImport = /(?:from|require\(|import\()\s*["']@earendil-works\//.test(code);
    if (bareImport) {
      warnings.push("full bundle still imports @earendil-works/* — deps not fully inlined?");
    }
  }

  // V7 — LIVE load test via the pi-agent bundle. Proves runtime resolution of
  // the externalized peer deps + factory invocation. Best-effort: skipped
  // (warned) if the host bundle is not built yet.
  if (existsSync(PI_AGENT_BUNDLE)) {
    try {
      const proc = Bun.spawn(
        [
          "bun", PI_AGENT_BUNDLE, "-ne", "-e", OUTFILE,
          "-p", "reply with only the literal token VLMDONE if you have a tool named vlm_describe, else NOTOOL",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // A load CRASH (NameTooLong / "Failed to load extension" / ResolveMessage)
      // is a HARD failure: the bundle is broken at its real shipping location.
      // This is exactly the failure mode a THIN bundle hits under jiti when
      // node_modules is reachable from OUTFILE's dir — jiti wraps the module
      // in an oversized data:text/javascript URL that bun rejects. A non-zero
      // exit WITHOUT a crash signature is a soft warning (transient provider
      // error); missing VLMDONE without a crash is also soft (LLM didn't answer).
      const crashSig = /failed to load extension|nametoolong|resolvemessage|resolve error/i;
      if (crashSig.test(stdout + stderr)) {
        failures.push(
          `live load CRASH at shipping location — bundle does not load: ${(stdout + stderr).slice(0, 180)}`,
        );
      } else if (exitCode !== 0) {
        warnings.push(`live load exited ${exitCode} (no crash signature) — stderr: ${stderr.slice(0, 160)}`);
      } else if (!stdout.toLowerCase().includes("vlmdone")) {
        warnings.push(`live load: agent booted but VLMDONE not in reply (LLM/provider issue?) — output: ${stdout.slice(0, 160)}`);
      } else {
        console.log(`  ✓ live load: pi-agent booted, vlm_describe registered`);
      }
    } catch (e: any) {
      warnings.push(`live load test threw: ${String(e?.message || e).slice(0, 120)}`);
    }
  } else {
    warnings.push(`live load test skipped — ${PI_AGENT_BUNDLE} not built (run pi-agent build first)`);
  }

  // Report
  for (const w of warnings) console.log(`  · WARN  ${w}`);
  if (failures.length) {
    for (const f of failures) console.error(`  ✗ FAIL  ${f}`);
    console.error(`  ✗ self-verify FAILED (${failures.length} hard failure(s))`);
    process.exit(1);
  }
  const checks = 6 + (existsSync(PI_AGENT_BUNDLE) ? 1 : 0);
  console.log(`  ✓ self-verify passed (${checks} checks, ${warnings.length} warning(s))`);
}

// ── Orchestrate ───────────────────────────────────────────────────────────────
await stageBundle();
stageResolveExternals(); // thin: rewrite bare specifiers → abs paths (no-op for full)
await stageObfuscate();
await stageVerify();
console.log("▶ done");
console.log(
  `  load with:  bun ../../dist/pi-agent/pi-agent.js -ne -e ${OUTFILE} -p "list your tools"`,
);
