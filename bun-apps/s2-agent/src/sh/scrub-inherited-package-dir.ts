/**
 * scrub-inherited-package-dir.ts — drop a PI_PACKAGE_DIR inherited from a
 * parent s2-agent process. Imported as the VERY FIRST import of the sh entry
 * (src/cli-sh.ts): pi's config.js resolves VERSION / APP_NAME /
 * CONFIG_DIR_NAME from <getPackageDir()>/package.json at module-init time —
 * empirically BEFORE the entry's own body runs — so the scrub must precede
 * any pi module initialization; ES side-effect import order guarantees that.
 *
 * Why this leaks at all: the extract-embedded-assets patch exports its cache
 * redirect on the session's process.env, and every child of a running session
 * (shells, tests, CI gates spawned from an agent) inherits it. A different
 * s2-agent binary booted under that redirect resolves its identity from the
 * SESSION's stale cache instead of the package.json beside its own
 * executable — a deploy-e2e binary printed the session's version, not its
 * own, which is how this scrub came to exist.
 *
 * Applies in BOTH binary and source mode (no isBunBinary gate): the redirect
 * is another instance's leak either way, and a source-mode pi resolves
 * themes/settings from the session's cache just as wrongly.
 *
 * Narrow by construction: only redirects whose path runs through
 * <any-root>/.pi/agent/embedded-assets/ are dropped — that location IS the
 * extraction cache by definition, so it is always another instance's leak,
 * never a deliberate operator override (those point elsewhere and stay
 * honored; the patch's ??= defers to them). extract-embedded-assets re-points
 * the var at THIS binary's own cache later in boot, after config resolved,
 * for the theme/asset directory lookups that read it dynamically.
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
