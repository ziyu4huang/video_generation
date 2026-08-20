/**
 * workspace-dist-staleness — the dist-root predicate, kept as the tripwire.
 *
 * HISTORY (incident 2026-08-15): `@repo/s2-agent-ext-workflow`'s entry was
 * `./dist/index.js` — a gitignored, locally built artifact. cf6f1394 removed
 * `homeDir` from the s2-agent-ext-subagent barrel and updated workflow's SRC to
 * import it from core-runtime, but the local dist was not rebuilt. At the next
 * `./s2-agent.sh` boot, `dist/workflow-paths.js` still imported the removed
 * `homeDir` from the subagent barrel → the native import of the movie-director
 * extension graph FAILED → jiti fell back to transforming the whole graph → the
 * first >4 KB module (ltx binary.ts) got base64-wrapped into a data URL → Bun
 * died with a cryptic `NameTooLong`. CI could never catch it: dist/ was
 * gitignored, so CI always built fresh — only a developer machine with a stale
 * local dist broke, at boot.
 *
 * The src-entry migration (.planning/2026-08-15-src-entry-migration/) retired
 * the whole class: all four dist-root packages (workflow, superpowers, wayfind,
 * webui) resolve to ./src/index.ts, their build steps are gone, and the boot
 * heal patch + staleness walkers were deleted with them. What survives is the
 * one predicate both the old machinery and the current
 * `bun-apps/tests/workspace-dist-fresh.test.ts` tripwire gate share: a package
 * whose root resolves into ./dist/ is a REGRESSION (it resurrects the class).
 */
/** Minimal package.json shape distEntryMain reads. */
export interface PkgJsonLike {
  main?: unknown;
  exports?: unknown;
}

/**
 * If the package's runtime entry resolves into `./dist/`, return that entry
 * (e.g. "./dist/index.js"); otherwise null. Packages whose entry is src/ (every
 * extension in this repo since the src-entry migration) have no build artifact
 * to go stale.
 */
export function distEntryMain(pkg: PkgJsonLike): string | null {
  const candidates: unknown[] = [pkg.main];
  const dot = (pkg.exports as Record<string, { import?: unknown }> | undefined)?.["."];
  if (dot && typeof dot === "object") candidates.push(dot.import);
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("./dist/")) return c;
  }
  return null;
}
