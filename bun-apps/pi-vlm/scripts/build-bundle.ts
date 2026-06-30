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
 *   bun scripts/build-bundle.ts              # minify only (identifier mangling)
 *   bun scripts/build-bundle.ts --obfuscate   # + javascript-obfuscator pass
 *   bun scripts/build-bundle.ts --out <path>  # override output path
 *   bun scripts/build-bundle.ts --sourcemap   # emit sourcemap (debug only)
 *
 * OUTPUT (repo-root dist/, consistent with dist/pi-agent/):
 *   ../../dist/pi-extensions/pi-vlm.bundle.js
 *
 * LOAD (with the pi-agent bundle):
 *   bun ../../dist/pi-agent/pi-agent.js -ne \
 *     -e ../../dist/pi-extensions/pi-vlm.bundle.js -p "list your tools"
 *
 * NOTES
 * -----
 * - `--minify` already renames local identifiers (e.g. `var A56=Object.create`),
 *   which defeats casual reading. `--obfuscate` adds string-array + control-flow
 *   transforms via javascript-obfuscator; it is OPTIONAL because (a) that package
 *   is not a default dep, and (b) on a multi-MB bundle it is slow and can
 *   significantly grow the file. Start with minify-only.
 * - typebox + `../src/pipeline.ts` + transitive deps are inlined. Bare-specifier
 *   `typebox/*` subpaths that survive are resolved by pi's loader aliases at
 *   runtime, so the bundle still loads.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const APP_NAME = "pi-vlm";
const ENTRY = "extensions/pi-vlm.ts";
const OUTDIR = resolve(process.cwd(), "..", "..", "dist", "pi-extensions");
const DEFAULT_OUTFILE = `${OUTDIR}/${APP_NAME}.bundle.js`;

const argv = process.argv.slice(2);
const DO_OBFUSCATE = argv.includes("--obfuscate");
const DO_SOURCEMAP = argv.includes("--sourcemap");
const outFlagIdx = argv.indexOf("--out");
const OUTFILE = outFlagIdx >= 0 ? argv[outFlagIdx + 1] : DEFAULT_OUTFILE;

function formatSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ── Stage 1: bundle + minify ─────────────────────────────────────────────────
async function stageBundle() {
  console.log(`▶ bundle + minify → ${ENTRY}`);
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
  });

  if (!result.success) {
    for (const l of result.logs) console.error(l);
    process.exit(1);
  }
  console.log(`  ✓ ${OUTFILE}  (${formatSize(Bun.file(OUTFILE).size)})`);
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

// ── Orchestrate ───────────────────────────────────────────────────────────────
await stageBundle();
await stageObfuscate();
console.log("▶ done");
console.log(
  `  load with:  bun ../../dist/pi-agent/pi-agent.js -ne -e ${OUTFILE} -p "list your tools"`,
);
