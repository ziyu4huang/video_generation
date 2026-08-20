// scripts/lib/codegen.ts
//
// All progress output here goes to STDERR: the deploy CLIs promise stdout is
// PURE JSON (deploy-sh-cli.ts convention), and these stages run under them.
import { existsSync, mkdirSync } from "node:fs";
import { generateEmbeddedAssets } from "../../../pi-agent/scripts/generate-embedded-assets.ts";

export const GENERATED_DIR = "src/generated";

function ensureOutdir() {
  if (!existsSync(GENERATED_DIR)) mkdirSync(GENERATED_DIR, { recursive: true });
}

// The pi-pkg-dir.ts and run-dir-base.ts stages lived here too. Both wrote
// build-time constants that ONLY the retired "bundle" mode read — set-package-dir
// and run-context's loadRunDirBase — so Phase 1b removed the readers and these
// writers together. embedded-assets is the one generated file the compiled
// binary actually consumes.

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
