/**
 * mode.ts — how was THIS module loaded? Shared detection for s2-agent's
 * patch + run-dir machinery.
 *
 * Bun's bundler/compiler rewrites `import.meta.url`, so the URL string is the
 * reliable signal for which execution mode we are in. This was previously
 * copy-pasted (the `$bunfs` / `~BUN` / `%7EBUN` marker check) across
 * run-dir/resolve.ts, set-package-dir.ts, and skip-update-check.ts — three
 * copies of fragile string-matching. Centralize it here so it is tested once.
 *
 *   - "binary":  `bun build --compile` → import.meta.url is Bun's virtual fs
 *                scheme ($bunfs, or its ~BUN / URL-encoded %7EBUN variants).
 *                Both shipped artifacts are this: the sh deploy's core and a
 *                plain compiled exe.
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
 * A "bundle" mode existed once before (a shipped `s2-agent.js` from the
 * retired `scripts/deploy.ts` four-mode pipeline, #1740). This is not that
 * revival: the name returns because the sh deploy's core now IS a bun-run
 * bundle (`.planning/2026-08-23-deploy-platform-neutral-core/`), with a new
 * producer and a new detection rule (`.js` extension, not source markers).
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type BundlerMode = "binary" | "bundle" | "source";

/** True when the URL is Bun's compiled-binary virtual fs scheme. */
export function isBunBinary(url: string): boolean {
  return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

/**
 * Classify the execution mode from the module URL.
 *
 * Takes no source-marker argument any more. While the FIRST "bundle" mode
 * existed, callers passed a substring unique to their own directory
 * ("/run-dir/", "/src/patches/") to tell source apart from a bundle that had
 * inlined them. The extension rule below replaces that: source URLs always
 * end in `.ts`, a bundle is one minified `.js`, and the compiled binary is
 * caught by isBunBinary first — so an argument that cannot change the answer
 * is still not offered.
 */
export function detectMode(url: string): BundlerMode {
  if (isBunBinary(url)) return "binary";
  return url.endsWith(".ts") ? "source" : "bundle";
}

/**
 * The directory a SHIPPED artifact should resolve its deploy-relative layout
 * (ext/, package.json, dist/ assets) from. In a compiled binary the module
 * URL is the $bunfs virtual scheme and only process.execPath names a real
 * file; in a bun-run bundle every module's rewritten import.meta.url IS the
 * bundle's real path, so its dirname is the deploy dir. Source mode returns
 * the src/ dir — meaningless as a deploy root, which is why source-mode
 * debugging of the sh entry goes through the PI_AGENT_SH_EXT_DIR override
 * instead.
 */
export function deployRoot(url: string): string {
  if (detectMode(url) === "binary") return dirname(process.execPath);
  return dirname(fileURLToPath(url));
}
