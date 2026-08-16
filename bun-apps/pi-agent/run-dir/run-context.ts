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
 * walks up two levels from this file's own directory, which is correct only
 * while this module lives in run-dir/. Bun's bundler rewrites import.meta.dir
 * to the bundle output location, which is why bundle mode reads baked constants
 * instead — see the header of resolve.ts for the full rationale.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectMode } from "../src/mode.ts";

const url = import.meta.url;

/** Layout mode for this process. Shared so every run-dir module branches identically. */
export const mode = detectMode(url);

/** The one run-dir log prefix. Every module's operator-facing output goes through it. */
export function warn(msg: string): void {
  console.error(`[bun-pi] run-dir: ${msg}`);
}

// Bundle mode reads build-time-baked constants from run-dir-base.ts. Cache the
// dynamic import so resolveBunAppsDir and resolveNpmExtensionPaths share ONE
// load. The module is absent in a clean source tree; the try/catch covers that.
let runDirBase: Promise<{ bunAppsDir: string | undefined; npmPaths: string[] }> | null = null;

export function loadRunDirBase(): Promise<{ bunAppsDir: string | undefined; npmPaths: string[] }> | null {
  if (mode === "bundle" && !runDirBase) {
    runDirBase = (async () => {
      try {
        // @ts-ignore — generated at build time; absent in a clean source tree
        const mod = await import("../src/generated/run-dir-base.ts");
        return {
          bunAppsDir: (mod.BUN_APPS_DIR as string | undefined) || undefined,
          npmPaths: (mod.NPM_EXTENSION_PATHS as string[] | undefined) ?? [],
        };
      } catch {
        return { bunAppsDir: undefined, npmPaths: [] };
      }
    })();
  }
  return runDirBase;
}

export async function resolveBunAppsDir(): Promise<string | undefined> {
  if (mode === "bundle") {
    // Bundle mode: only the build-time-generated constant is reliable.
    return (await loadRunDirBase())?.bunAppsDir;
  }
  // Source mode: run-dir/run-context.ts -> pi-agent/ -> bun-apps/
  return resolve(dirname(fileURLToPath(url)), "..", "..");
}
