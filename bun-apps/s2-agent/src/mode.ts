/**
 * mode.ts — how was THIS module loaded? Shared detection for s2-agent's
 * patch + run-dir machinery.
 *
 * Bun's bundler rewrites `import.meta.url`, so the URL string is the
 * reliable signal for which execution mode we are in. This was previously
 * copy-pasted (a compiled-binary marker check) across src/run-dir/resolve.ts,
 * set-package-dir.ts, and skip-update-check.ts — three copies of fragile
 * string-matching. Centralize it here so it is tested once.
 *
 *   - "bundle":  `bun build --target=bun` → every bundled module's rewritten
 *                import.meta.url is the ONE shipped `.js` file (the sh
 *                deploy's core since 2026-08-23). Distinguished from source
 *                by extension: a source boot always runs `.ts` module URLs
 *                under bun-apps/s2-agent/src/, never a minified `.js`. No
 *                build-time define is used — an env-based marker would leak
 *                into every child process (the exact inheritance bug class
 *                scrub-inherited-package-dir.ts exists for).
 *   - "source":  everything else — `bun src/cli.ts` from the repo.
 *
 * A third mode, "binary" (`bun build --compile`, import.meta.url under Bun's
 * $bunfs virtual scheme), existed for the compiled sh core and was deleted
 * with it (deploy-platform-neutral-core ticket 03, 2026-08-23): nothing in
 * this repo produces a compiled artifact any more, and the compiled version
 * dirs retention still holds carry their own frozen copies of this file.
 *
 * A "bundle" mode existed once before (a shipped `s2-agent.js` from the
 * retired `scripts/deploy.ts` four-mode pipeline, #1740). This is not that
 * revival: the name returns because the sh deploy's core now IS a bun-run
 * bundle (`.planning/2026-08-23-deploy-platform-neutral-core/`), with a new
 * producer and a new detection rule (`.js` extension, not source markers).
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type BundlerMode = "bundle" | "source";

/**
 * Classify the execution mode from the module URL.
 *
 * Takes no source-marker argument any more. While the FIRST "bundle" mode
 * existed, callers passed a substring unique to their own directory
 * ("/run-dir/", "/src/patches/") to tell source apart from a bundle that had
 * inlined them. The extension rule below replaces that: source URLs always
 * end in `.ts`, and a bundle is one minified `.js` — so an argument that
 * cannot change the answer is still not offered.
 */
export function detectMode(url: string): BundlerMode {
  return url.endsWith(".ts") ? "source" : "bundle";
}

/**
 * The directory a SHIPPED artifact should resolve its deploy-relative layout
 * (ext/, package.json, dist/ assets) from. In a bun-run bundle every module's
 * rewritten import.meta.url IS the bundle's real path, so its dirname is the
 * deploy dir. Source mode returns the src/ dir — meaningless as a deploy
 * root, which is why source-mode debugging of the sh entry goes through the
 * PI_AGENT_SH_EXT_DIR override instead.
 */
export function deployRoot(url: string): string {
  return dirname(fileURLToPath(url));
}
