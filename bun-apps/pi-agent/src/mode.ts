/**
 * mode.ts — how was THIS module loaded? Shared detection for pi-agent's
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
 *   - "source":  loaded from source (the URL contains a path marker unique to
 *                the call site, e.g. "/run-dir/" or "/src/patches/").
 *   - "bundle":  bundled .js (the supported shipped path).
 */

export type BundlerMode = "binary" | "source" | "bundle";

/** True when the URL is Bun's compiled-binary virtual fs scheme. */
export function isBunBinary(url: string): boolean {
  return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

/**
 * Classify the execution mode from the module URL.
 *
 * @param url           the import.meta.url to classify
 * @param sourceMarker  substring that identifies source-mode loading for the
 *                      call site (defaults to "/run-dir/"; patches use
 *                      "/src/patches/"). Binary takes precedence over source.
 */
export function detectMode(url: string, sourceMarker = "/run-dir/"): BundlerMode {
  if (isBunBinary(url)) return "binary";
  if (url.includes(sourceMarker)) return "source";
  return "bundle";
}
