/**
 * run-context.ts — the three module-level facts every run-dir module has to
 * agree on: which layout mode this process is running in, where bun-apps/ is,
 * and how to warn.
 *
 * Extracted when resolve.ts was split (spec step 1c). All three were computed
 * once inside resolve.ts and read by the deps probe, the lazy-alias resolver,
 * and the argv builders alike — so they had to become shared rather than be
 * recomputed per module. Recomputing `detectMode(import.meta.url)` in each
 * sibling would work (they all sit in run-dir/, so the "/run-dir/" source
 * marker matches), but that is a second source of truth for exactly the thing
 * src/mode.ts was created to centralize.
 *
 * `import.meta.url` MUST stay meaningful here: in source mode resolveBunAppsDir
 * walks up three levels from this file's own directory (src/run-dir/ → src/ →
 * s2-agent/ → bun-apps/), which is correct only while this module lives in
 * run-dir/ below src/. The compiled binary never asks — it
 * resolves nothing from the repo — so source is the only case left to serve.
 * Bundle mode used to read baked constants from src/generated/run-dir-base.ts
 * for exactly this reason; both the mode and that generated file went in
 * Phase 1b (see the header of resolve.ts).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectMode } from "../mode.ts";
import { findRepoRoot } from "../paths.ts";

const url = import.meta.url;

/** Layout mode for this process. Shared so every run-dir module branches identically. */
export const mode = detectMode(url);

/** The one run-dir log prefix. Every module's operator-facing output goes through it. */
export function warn(msg: string): void {
  console.error(`[bun-pi] run-dir: ${msg}`);
}

export async function resolveBunAppsDir(): Promise<string | undefined> {
  // Marker walk (nearest ancestor containing bun-apps/, round-2 ticket 05 —
  // was a fixed three-level resolve that broke if this module ever moved depth).
  // undefined now means what the signature always claimed: no bun-apps ancestor
  // (deploy layouts never ask — see header).
  const root = findRepoRoot(dirname(fileURLToPath(url)));
  return root === undefined ? undefined : join(root, "bun-apps");
}
