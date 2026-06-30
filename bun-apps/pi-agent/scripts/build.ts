/**
 * Build pipeline for pi-agent.
 *
 * Tiers:
 *   bun scripts/build.ts            bundle + minify + external sourcemap
 *   bun scripts/build.ts --compile  bun --compile → standalone executable
 *   bun scripts/build.ts --all      bundle + compile
 *
 * Output (repo root dist/, namespaced):
 *   ../../dist/pi-agent/pi-agent.js      bundled entry (minified)
 *   ../../dist/pi-agent/pi-agent.js.map  sourcemap (debug only — embeds full source)
 *   ../../dist/pi-agent/pi-agent         standalone executable (--compile only)
 *
 * The bundle is self-contained: all patches and providers are statically
 * imported and included. No external packages or .pi/ paths needed at runtime.
 *
 * NOTE: bun --compile does not encrypt JS — source is embedded as plaintext
 * strings inside the binary. The binary is convenient but not hardened.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";

const APP_NAME: string = basename(process.cwd()); // "pi-agent"
const ENTRY = "src/cli.ts";
const OUTDIR = resolve(process.cwd(), "..", "..", "dist", APP_NAME);
const OUTFILE = `${OUTDIR}/${APP_NAME}.js`;
const MAPFILE = `${OUTFILE}.map`;
const EXE = `${OUTDIR}/${APP_NAME}`;

const argv = process.argv.slice(2);
const DO_COMPILE = argv.includes("--compile") || argv.includes("--all");

function ensureOutdir() {
  if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
}

function clean(...files: string[]) {
  for (const f of files) if (existsSync(f)) rmSync(f);
}

async function stageBundle() {
  console.log(`▶ bundle + minify → dist/${APP_NAME}/${APP_NAME}.js`);
  ensureOutdir();
  clean(OUTFILE, MAPFILE, EXE);

  const { build } = await import("bun");
  const result = await build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    target: "bun",
    format: "esm",
    naming: `${APP_NAME}.js`,
    minify: { whitespace: true, identifiers: true, syntax: true },
    sourcemap: "external",
    splitting: false,
  });

  if (!result.success) {
    for (const l of result.logs) console.error(l);
    process.exit(1);
  }

  // Link sourceMappingURL so debuggers resolve minified stack traces.
  appendFileSync(OUTFILE, `\n//# sourceMappingURL=${APP_NAME}.js.map\n`);
  console.log(`  ✓ ${OUTFILE}  (${formatSize(OUTFILE)})`);
  console.log(`  ✓ ${MAPFILE}  (debug only — embeds full source)`);
}

async function stageCompile() {
  console.log(`▶ compile → dist/${APP_NAME}/${APP_NAME}  (standalone binary)`);
  clean(EXE);
  const proc = Bun.spawn(
    ["bun", "build", OUTFILE, "--compile", `--outfile=${EXE}`, "--minify"],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`  ✗ bun build --compile exited ${code}`);
    process.exit(code);
  }
  console.log(`  ✓ ${EXE}  (${formatSize(EXE)})`);
}

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

await stageBundle();
if (DO_COMPILE) await stageCompile();

console.log("▶ done");
if (existsSync(MAPFILE)) {
  console.log("");
  console.log("  ⚠  sourcemap present — contains full original source.");
  console.log("     Remove before shipping:  rm dist/pi-agent/pi-agent.js.map");
}
