/**
 * build-bundle.ts — bundle the s2-agent-ext-ltx extension into one minified .js
 * loadable via `pi -e <bundle>.js`. Mirrors s2-agent-ext-flux2/scripts/build-bundle.ts.
 *
 *   bun scripts/build-bundle.ts            # minify only
 *   bun scripts/build-bundle.ts --obfuscate # + javascript-obfuscator pass
 *   bun scripts/build-bundle.ts --out <p>   # override output path
 *
 * Output: ../../dist/pi-extensions/s2-agent-ext-ltx.bundle.js
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const APP_NAME = "s2-agent-ext-ltx";
const ENTRY = "extensions/ltx.ts";
const OUTDIR = resolve(process.cwd(), "..", "..", "dist", "pi-extensions");
const DEFAULT_OUTFILE = `${OUTDIR}/${APP_NAME}.bundle.js`;

const argv = process.argv.slice(2);
const DO_OBFUSCATE = argv.includes("--obfuscate");
const outFlagIdx = argv.indexOf("--out");
const OUTFILE = outFlagIdx >= 0 ? argv[outFlagIdx + 1] : DEFAULT_OUTFILE;

function formatSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

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
    sourcemap: "none",
    splitting: false,
  });

  if (!result.success) {
    for (const l of result.logs) console.error(l);
    process.exit(1);
  }
  console.log(`  ✓ ${OUTFILE}  (${formatSize(Bun.file(OUTFILE).size)})`);
}

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
    selfDefending: false,
    target: "browser",
    ignoreImports: true,
  });
  writeFileSync(OUTFILE, result.getObfuscatedCode());
  console.log(`  ✓ ${OUTFILE}  (${formatSize(Bun.file(OUTFILE).size)})`);
}

await stageBundle();
await stageObfuscate();
console.log("▶ done");
console.log(
  `  load with:  bun ../../dist/s2-agent/s2-agent.js -ne -e ${OUTFILE} -p "list your tools"`,
);
