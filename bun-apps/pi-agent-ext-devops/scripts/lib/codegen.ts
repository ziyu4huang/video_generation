// scripts/lib/codegen.ts
//
// All progress output here goes to STDERR: the deploy CLIs promise stdout is
// PURE JSON (deploy-sh-cli.ts convention), and these stages run under them.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateEmbeddedAssets } from "../../../pi-agent/scripts/generate-embedded-assets.ts";

export const GENERATED_DIR = "src/generated";
const GENERATED_PKG_DIR = `${GENERATED_DIR}/pi-pkg-dir.ts`;
const GENERATED_RUN_DIR_BASE = `${GENERATED_DIR}/run-dir-base.ts`;

function ensureOutdir() {
  if (!existsSync(GENERATED_DIR)) mkdirSync(GENERATED_DIR, { recursive: true });
}

export interface NpmExt { pkg: string; entry: string }

export function stageGeneratePkgDir(piPkgDir: string) {
  console.error(`▶ generate src/generated/pi-pkg-dir.ts`);
  ensureOutdir();
  writeFileSync(
    GENERATED_PKG_DIR,
    `// AUTO-GENERATED — do not edit or commit\n` +
    `export const PI_PKG_DIR = ${JSON.stringify(piPkgDir)};\n`,
  );
  console.error(`  ✓ PI_PKG_DIR = ${piPkgDir}`);
}

export function stageGenerateRunDirBase(npmExtensions: NpmExt[]) {
  console.error(`▶ generate src/generated/run-dir-base.ts`);
  ensureOutdir();
  const bunAppsDir = resolve(process.cwd(), "..");
  const npmExtensionPaths: string[] = [];
  for (const { pkg, entry } of npmExtensions) {
    try {
      const pkgJsonUrl = import.meta.resolve(`${pkg}/package.json`);
      const pkgDir = dirname(new URL(pkgJsonUrl).pathname);
      npmExtensionPaths.push(`${pkgDir}/${entry}`);
    } catch {
      console.error(`  · skipping npm extension "${pkg}" (not resolvable)`);
    }
  }
  writeFileSync(
    GENERATED_RUN_DIR_BASE,
    `// AUTO-GENERATED — do not edit or commit\n` +
    `export const BUN_APPS_DIR = ${JSON.stringify(bunAppsDir)};\n` +
    `export const NPM_EXTENSION_PATHS = ${JSON.stringify(npmExtensionPaths, null, 2)};\n`,
  );
  console.error(`  ✓ BUN_APPS_DIR = ${bunAppsDir}`);
  console.error(`  ✓ ${npmExtensionPaths.length} npm extension path(s) resolved`);
}

export function stageGenerateEmbeddedAssets(
  piPkgDir: string,
  bunAppsDir: string,
  binarySkills: string[],
  embedMode: boolean,
) {
  console.error(`▶ generate src/generated/embedded-assets.ts${embedMode ? " (with imports)" : " (empty manifest)"}`);
  ensureOutdir();
  generateEmbeddedAssets(piPkgDir, bunAppsDir, binarySkills, embedMode);
}
