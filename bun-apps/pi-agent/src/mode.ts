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
 *                Both shipped artifacts are this: the sh deploy's core and a
 *                plain compiled exe.
 *   - "source":  everything else — `bun src/cli.ts` from the repo.
 *
 * There used to be a third mode, "bundle": a shipped `pi-agent.js` produced by
 * `scripts/deploy.ts`. That script and its four deploy modes were retired in
 * #1740, and nothing has produced a bundle since. The mode outlived its
 * producer by one release; it is gone now, and `dead-deploy-markers.test.ts`
 * keeps its layout markers unwritten.
 */

export type BundlerMode = "binary" | "source";

/** True when the URL is Bun's compiled-binary virtual fs scheme. */
export function isBunBinary(url: string): boolean {
  return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

/**
 * Classify the execution mode from the module URL.
 *
 * Takes no source-marker argument any more. While "bundle" existed, callers
 * passed a substring unique to their own directory ("/run-dir/",
 * "/src/patches/") to tell source apart from a bundle that had inlined them.
 * With one non-binary mode left, that argument could no longer change the
 * result — an argument that cannot affect the answer is a trap, so it is not
 * offered.
 */
export function detectMode(url: string): BundlerMode {
  return isBunBinary(url) ? "binary" : "source";
}
