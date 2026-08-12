/**
 * Bundle the pi-file2md extension into a single minified (and optionally
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
 *   bun scripts/build-bundle.ts --thin        # THIN bundle — peer deps external, OBFUSCATED by default
 *   bun scripts/build-bundle.ts --thin --no-obfuscate  # thin, minify only (opt out)
 *   bun scripts/build-bundle.ts --obfuscate   # force obfuscation on (e.g. for FULL)
 *   bun scripts/build-bundle.ts --out <path>  # override output path
 *   bun scripts/build-bundle.ts --sourcemap   # emit sourcemap (debug only)
 *   bun scripts/build-bundle.ts --no-verify   # skip the self-verify stage
 *
 * OUTPUT (repo-root dist/, consistent with dist/pi-agent/):
 *   ../../dist/pi-extensions/pi-file2md.bundle.js   (full, ~6.8 MB)
 *   ../../dist/pi-extensions/pi-file2md.thin.js     (thin, ~25 KB)   [--thin]
 *
 * LOAD (with the pi-agent bundle):
 *   bun ../../dist/pi-agent/pi-agent.js -ne \
 *     -e ../../dist/pi-extensions/pi-file2md.bundle.js -p "list your tools"
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
 *   which defeats casual reading. The javascript-obfuscator pass (string-array +
 *   base64 encoding) is ON BY DEFAULT for thin — the 25 KB bundle is mostly your
 *   own logic, so minify alone leaves it readable; obfuscation is the real
 *   source-protection lever and it's cheap on 25 KB. It's OFF by default for FULL
 *   (slow + bloating on 6.8 MB; FULL already has obfuscation-by-volume from the
 *   inlined babel noise). `--no-obfuscate` opts out; `--obfuscate` forces it on.
 *   javascript-obfuscator is a declared devDependency, so a missing install when
 *   obfuscation is requested is a hard error (not a silent skip).
 * - The self-verify stage (--no-verify to skip) runs static integrity checks on
 *   the output AND, when the pi-agent bundle is present, a live load test that
 *   asserts file2md registers. See stageVerify.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findLeakedHomePaths } from "./verify-portability.ts";

const APP_NAME = "pi-file2md";
const ENTRY = "extensions/file2md.ts";
const OUTDIR = resolve(process.cwd(), "..", "..", "dist", "pi-extensions");
const DEFAULT_OUTFILE = `${OUTDIR}/${APP_NAME}.bundle.js`;

// Peer deps kept external in --thin mode. These are exactly the bare specifiers
// pi-file2md imports that are NOT node: builtins or relative project source. After
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
  "fs",
  "os",
  "path",
  "url",
  "child_process",
  "http",
  "https",
  "crypto",
  "stream",
  "util",
  "buffer",
  "events",
  "net",
  "tls",
  "zlib",
  "querystring",
  "string_decoder",
]);

// Where the pi-agent bundle lives, for the live load test. Resolved from the
// script's cwd (bun-apps/pi-file2md/) → repo root → dist/pi-agent/.
const PI_AGENT_BUNDLE = resolve(process.cwd(), "..", "..", "dist", "pi-agent", "pi-agent.js");

const argv = process.argv.slice(2);
const DO_THIN = argv.includes("--thin");
// Obfuscation: default ON for thin (25 KB of mostly own logic → low
// obfuscation-by-volume, so the javascript-obfuscator pass is needed for real
// source protection), default OFF for full (6.8 MB already noisy, and the pass
// is slow on it). --obfuscate forces on, --no-obfuscate forces off.
const FORCE_OBFUSCATE = argv.includes("--obfuscate");
const FORCE_NO_OBFUSCATE = argv.includes("--no-obfuscate");
const DO_OBFUSCATE = FORCE_NO_OBFUSCATE ? false : DO_THIN || FORCE_OBFUSCATE;
const DO_SOURCEMAP = argv.includes("--sourcemap");
const DO_VERIFY = !argv.includes("--no-verify");
const outFlagIdx = argv.indexOf("--out");
const OUTFILE = outFlagIdx >= 0 ? argv[outFlagIdx + 1] : DO_THIN ? `${OUTDIR}/${APP_NAME}.thin.js` : DEFAULT_OUTFILE;

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
// module exceeds a low-KB limit (~between 267 B and 3.2 KB; every real pi-file2md
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
// file2md with all 9 params, runs the full pipeline.
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
  try {
    return require.resolve(spec);
  } catch {} // works for typebox + subpaths
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
    if (!abs) {
      unresolved.push(spec);
      continue;
    }
    code = code.replace(new RegExp(`(["'])${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g"), `"${abs}"`);
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

// ── Stage 2: javascript-obfuscator pass ───────────────────────────────────────
// ON by default for thin (see DO_OBFUSCATE). Uses a moderate preset — full
// controlFlowFlattening + stringArray on a multi-MB FULL bundle is slow and
// bloating; tune OBFUSCATOR_OPTIONS if you need heavier. javascript-obfuscator
// is a declared devDependency, so a missing import here is a hard error, not a
// skip (a default-on stage must actually run).
async function stageObfuscate() {
  if (!DO_OBFUSCATE) return;
  console.log(`▶ obfuscate (javascript-obfuscator)`);
  let obf: any;
  try {
    obf = (await import("javascript-obfuscator")).default;
  } catch {
    console.error(
      "  ✗ javascript-obfuscator not installed, but obfuscation is ON.\n" +
        "    (obfuscation is default for --thin.) Install: bun add -d javascript-obfuscator\n" +
        "    Or opt out: bun scripts/build-bundle.ts --thin --no-obfuscate",
    );
    process.exit(1);
  }
  const code = readFileSync(OUTFILE, "utf8");
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

// ── Stage 2b: deterministic factory invocation (verify tier B) ────────────────
// The pi-file2md factory (extensions/file2md.ts) touches exactly two pi-API surfaces
// at registration time — pi.on("session_start", …) and pi.registerTool({name:
// "file2md", parameters: Type.Object({...})}). So a mock with just those
// two methods exercises the REAL registration path, including the typebox
// Type.Object(...) schema construction via the abs-path-resolved typebox import.
// This is option-independent (it observes behavior, not encoded strings), so it
// is the PRIMARY correctness gate and runs in every mode (thin/full × minify/
// obfuscated). A failure here is always a real defect.
const EXPECTED_VLM_PARAMS = ["input", "out", "model", "provider", "thinking", "type", "pages", "dpi", "relpath"];

async function liveFactoryTest(): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  // import() the built file via a file:// URL. For THIN this also proves every
  // baked absolute dep path resolves at module top-level (a wrong path throws
  // here, before the factory is ever called).
  let mod: any;
  try {
    mod = await import(pathToFileURL(OUTFILE).href);
  } catch (e: any) {
    return {
      ok: false,
      detail: `import() failed (broken ESM / unresolved abs-path dep under thin): ${String(e?.message || e).slice(0, 200)}`,
    };
  }
  if (typeof mod?.default !== "function") {
    return {
      ok: false,
      detail: `default export is not a factory function (got ${typeof mod?.default}) — pi loader cannot invoke it`,
    };
  }
  const tools: any[] = [];
  const mockApi = {
    on: () => {}, // session_start handler registration — no-op
    registerTool: (def: any) => tools.push(def),
  };
  try {
    mod.default(mockApi);
  } catch (e: any) {
    return {
      ok: false,
      detail: `factory threw on invocation (dep load / typebox schema build failed): ${String(e?.message || e).slice(0, 200)}`,
    };
  }
  const vlm = tools.find((t) => t?.name === "file2md");
  if (!vlm) {
    const names = tools.map((t) => t?.name).filter(Boolean);
    return {
      ok: false,
      detail: `factory registered no file2md tool (got: ${names.join(", ") || "none"})`,
    };
  }
  // typebox Type.Object({...}) serializes to {type:"object", required:[...],
  // properties:{<param>:<schema>}} — the parameter NAMES are the keys of
  // .properties, not of parameters itself.
  const gotKeys = Object.keys(vlm.parameters?.properties ?? {});
  const missing = EXPECTED_VLM_PARAMS.filter((k) => !gotKeys.includes(k));
  if (missing.length) {
    return {
      ok: false,
      detail: `file2md.parameters missing key(s): ${missing.join(", ")} (got: ${gotKeys.join(", ") || "none"})`,
    };
  }
  return {
    ok: true,
    detail: `file2md registered, ${gotKeys.length} params (${gotKeys.join(",")}); ${tools.length} tool(s) total`,
  };
}

// ── Stage 3: self-verify reviewer ─────────────────────────────────────────────
// Runs AFTER bundle (+ obfuscate). Three tiers:
//
//   (A) STATIC STRING-PATTERN checks — MINIFY-ONLY. Inspect the output bytes for
//   the invariants a valid pi extension bundle must hold: an ESM default export,
//   a registerTool call, the minify-mangle signature, no dangling ../src refs,
//   and (thin) every bare specifier abs-resolved / (full) no bare @earendil
//   import left. These are minify-only because javascript-obfuscator output is
//   NON-DETERMINISTIC across runs (random identifier generation + string-array
//   layout, no seed) and stuffs body literals into a base64 string-array
//   decoder — so the file body randomly contains `from`/`import(`/quote/
//   `registerTool` substrings as string-array DATA, which these regexes match
//   as false positives. Reliable only on clean minify-only output.
//
//   (B) DETERMINISTIC FACTORY INVOCATION (always, hard-fail) — the PRIMARY
//   correctness gate, and the only one that runs under obfuscation. Dynamically
//   import() the bundle and invoke its default factory with a mock pi API, then
//   assert file2md registers with its full 9-key parameter schema. Proves
//   the bundle is valid loadable ESM, every baked absolute dep path resolves
//   (thin), the real typebox schema constructs, and the tool registers — with
//   NO host bundle and regardless of how/whether obfuscation encoded the
//   literals. This obfuscation-proofs the verify stage: the old code skipped
//   nearly everything when obfuscated, and the default --thin build IS
//   obfuscated, so that meant almost no verification. (B) fixes that.
//
//   (C) JITI / AGENT LIVE BOOT (when dist/pi-agent/pi-agent.js exists): boot
//   the real pi-agent bundle with `-ne -e <bundle>`. This is the ONLY tier
//   that exercises pi's jiti loader (the data:text/javascript wrapping that
//   triggers NameTooLong on a thin bundle whose bare specifiers weren't
//   abs-resolved) — tier (B) uses bun's native import(), which bypasses jiti.
//   So (B) is the correctness gate and (C) is the jiti-integration gate.
//   Skipped (warned, not failed) when the host bundle is absent.
//
// Any HARD failure exits 1 so CI / a bad edit can't ship a broken bundle
// silently. (C)-skip and obfuscation-density notes are warnings only.
async function stageVerify() {
  if (!DO_VERIFY) return;
  console.log(`▶ self-verify`);
  const code = readFileSync(OUTFILE, "utf8");
  const bytes = Buffer.byteLength(code);
  const failures: string[] = [];
  const warnings: string[] = [];

  // (A) STATIC checks ----------------------------------------------------------
  //
  // V4 — size sanity (ALWAYS). Full ~6.8MB, thin ~25KB (minify-only) / ~50KB
  // (obfuscated). A 0-byte or implausibly tiny output means the build silently
  // produced an empty/stub file.
  const maxBytes = DO_THIN ? 500_000 : 15_000_000;
  const minBytes = DO_THIN ? 5_000 : 1_000_000;
  if (bytes < minBytes) {
    failures.push(
      `output ${formatSize(bytes)} below expected minimum ${formatSize(minBytes)} — likely a stub/empty build`,
    );
  }
  if (bytes > maxBytes) {
    warnings.push(`output ${formatSize(bytes)} above expected ceiling ${formatSize(maxBytes)} — dep graph grew?`);
  }

  // V1–V3, V5, V6 — STATIC STRING-PATTERN checks on the output bytes. MINIFY-
  // ONLY. Every one of these greps the bytes for a substring/regex (an export
  // form, `registerTool`, the mangle signature, a `from "…"` specifier, a
  // ../src path). javascript-obfuscator output is non-deterministic across
  // runs (random identifier generation + string-array layout, no seed), AND it
  // stuffs body literals into a base64 string-array decoder — so the file's
  // body randomly contains `from`/`import(`/quote/`registerTool` substrings as
  // string-array DATA, which these regexes match as false positives (one run
  // shows `registerTool` literally, the next encodes it). They are reliable
  // only on minify-only output, where imports/exports are clean and literals
  // are intact. The obfuscated path is covered BEHAVIORALLY by tier (B) below,
  // which proves the same invariants (export default is a function, deps
  // resolve, file2md registers) by actually invoking the factory.
  if (!DO_OBFUSCATE) {
    // V1 — default factory export survived bundling (accept the object-literal
    // `default:` form too).
    if (!/export\s+default/.test(code) && !code.includes("default:")) {
      failures.push("no ESM default export found — pi loader cannot import this");
    }
    // `registerTool` literal — the extension registers nothing without it.
    if (!code.includes("registerTool")) {
      failures.push("registerTool call missing — extension registers nothing");
    }

    // V2 — minify applied (short-mangled identifiers).
    const mangled = /\bvar\s+[A-Za-z0-9$_]{1,3}\s*=\s*Object\.(create|defineProperty)/.test(code);
    if (!mangled) {
      warnings.push(
        "no short-mangled identifiers detected — minify may not have applied " + "(re-check --minify / target)",
      );
    }

    // V3 — no dangling ../src/ relative imports (a project file escaped inlining).
    const danglingSrc = code.match(/\.\.\/src\/[a-z][a-z0-9./-]*/gi);
    if (danglingSrc) {
      failures.push(`dangling relative src refs not inlined: ${[...new Set(danglingSrc)].slice(0, 5).join(", ")}`);
    }
    if (!DO_THIN) {
      // Thin mode INTENTIONALLY embeds absolute dep paths — that's the fix; exempt.
      // Full bundle must stay portable across mac/Linux/Windows (shared verifier).
      warnings.push(...findLeakedHomePaths(code));
    }

    // V5 (thin only) — every bare specifier resolved to an absolute path; a
    // surviving bare non-builtin import would re-trigger jiti's data-URL wrap.
    if (DO_THIN) {
      const bareLeft = [...code.matchAll(/(?:from|import\()\s*["']([^"'#.][^"'']*?)["']/g)]
        .map((m) => m[1])
        .filter((s) => !s.startsWith("node:") && !BUILTINS.has(s) && !s.startsWith("/"));
      if (bareLeft.length) {
        failures.push(
          `thin: bare specifier(s) not resolved to abs path: ${[...new Set(bareLeft)].slice(0, 5).join(", ")}`,
        );
      }
      if (!/from\s*["']\/[^"']+typebox[^"']*["']/.test(code) && !/import\(\s*["']\/[^"']*typebox/.test(code)) {
        warnings.push("thin: no absolute-path typebox import found — did stageResolveExternals run?");
      }
    }

    // V6 (full only) — deps actually inlined (no bare @earendil import left).
    if (!DO_THIN) {
      const bareImport = /(?:from|require\(|import\()\s*["']@earendil-works\//.test(code);
      if (bareImport) {
        warnings.push("full bundle still imports @earendil-works/* — deps not fully inlined?");
      }
    }
  } else {
    console.log(
      `  · obfuscated output — static string checks skipped (obfuscator output is non-deterministic; factory test is authoritative)`,
    );
  }

  // (B) DETERMINISTIC FACTORY INVOCATION — primary correctness gate.
  // Runs always, hard-fails. See liveFactoryTest + the tier-(B) doc comment.
  const factory = await liveFactoryTest();
  if (!factory.ok) {
    failures.push(`factory test: ${factory.detail}`);
  } else {
    console.log(`  ✓ factory: ${factory.detail}`);
  }

  // (C) JITI / AGENT LIVE BOOT — the only tier that exercises pi's jiti loader.
  // Proves runtime resolution of the externalized peer deps + factory invocation
  // through the REAL load path (bun's native import() in tier B bypasses jiti).
  // Best-effort: skipped (warned) if the host bundle is not built yet.
  if (existsSync(PI_AGENT_BUNDLE)) {
    try {
      const proc = Bun.spawn(
        [
          "bun",
          PI_AGENT_BUNDLE,
          "-ne",
          "-e",
          OUTFILE,
          "-p",
          "reply with only the literal token FILE2MDDONE if you have a tool named file2md, else NOTOOL",
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
      // error); missing FILE2MDDONE without a crash is also soft (LLM didn't answer).
      const crashSig = /failed to load extension|nametoolong|resolvemessage|resolve error/i;
      if (crashSig.test(stdout + stderr)) {
        failures.push(
          `live load CRASH at shipping location — bundle does not load: ${(stdout + stderr).slice(0, 180)}`,
        );
      } else if (exitCode !== 0) {
        warnings.push(`live load exited ${exitCode} (no crash signature) — stderr: ${stderr.slice(0, 160)}`);
      } else if (!stdout.toLowerCase().includes("file2mdone")) {
        warnings.push(
          `live load: agent booted but FILE2MDDONE not in reply (LLM/provider issue?) — output: ${stdout.slice(0, 160)}`,
        );
      } else {
        console.log(`  ✓ live load: pi-agent booted, file2md registered`);
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
  // (A) size + (B) factory always = 2; minify-only adds the static string checks
  // (export, registerTool, dangling-src, import-specifier) = +4; (C) jiti live
  // boot = +1 when the host bundle is present.
  const checks = 2 + (!DO_OBFUSCATE ? 4 : 0) + (existsSync(PI_AGENT_BUNDLE) ? 1 : 0);
  console.log(`  ✓ self-verify passed (${checks} checks, ${warnings.length} warning(s))`);
}

// ── Orchestrate ───────────────────────────────────────────────────────────────
await stageBundle();
stageResolveExternals(); // thin: rewrite bare specifiers → abs paths (no-op for full)
await stageObfuscate();
await stageVerify();
console.log("▶ done");
console.log(`  load with:  bun ../../dist/pi-agent/pi-agent.js -ne -e ${OUTFILE} -p "list your tools"`);
