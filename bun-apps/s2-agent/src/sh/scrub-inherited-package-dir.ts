/**
 * scrub-inherited-package-dir.ts — drop a PI_PACKAGE_DIR inherited from a
 * parent s2-agent process. Imported as the VERY FIRST import of the sh entry
 * (src/cli-sh.ts): pi's config.js resolves VERSION / APP_NAME /
 * CONFIG_DIR_NAME from <getPackageDir()>/package.json at module-init time —
 * empirically BEFORE the entry's own body runs — so the scrub must precede
 * any pi module initialization; ES side-effect import order guarantees that.
 *
 * Why this leaks at all: the (now-deleted) extract-embedded-assets patch of
 * the compiled core exported its cache redirect on the session's process.env,
 * and every child of a running session (shells, tests, CI gates spawned from
 * an agent) inherits it. A different s2-agent binary booted under that
 * redirect resolves its identity from the SESSION's stale cache instead of
 * the package.json beside its own executable — a deploy-e2e binary printed
 * the session's version, not its own, which is how this scrub came to exist.
 * The patch is gone from THIS tree (deploy-platform-neutral-core ticket 03,
 * 2026-08-23), but retention still holds compiled version dirs whose frozen
 * binaries set the var — so the scrub stays as long as those can run.
 *
 * Applies in BOTH bundle and source mode: the redirect is another instance's
 * leak either way, and a source-mode pi resolves themes/settings from the
 * session's cache just as wrongly.
 *
 * Narrow by construction: only redirects whose path runs through
 * <any-root>/.pi/agent/embedded-assets/ are dropped — that location IS the
 * extraction cache by definition, so it is always another instance's leak,
 * never a deliberate operator override (those point elsewhere and stay
 * honored).
 *
 * The same scrub also runs as a bunfig preload (scripts/scrub-session-env
 * .preload.ts) for `bun test` / source boots in this package, which never
 * import an entry point.
 */
import { join, sep } from "node:path";

export const EMBEDDED_ASSETS_CACHE_MARKER = join(".pi", "agent", "embedded-assets") + sep;

const inherited = process.env.PI_PACKAGE_DIR;
if (inherited?.includes(EMBEDDED_ASSETS_CACHE_MARKER)) {
	delete process.env.PI_PACKAGE_DIR;
}
