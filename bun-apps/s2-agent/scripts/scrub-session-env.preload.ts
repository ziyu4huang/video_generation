// scrub-session-env.preload.ts — bunfig preload for this package: drop a
// PI_PACKAGE_DIR inherited from a parent s2-agent session BEFORE any test or
// source-mode module initializes. Same leak + same narrow rule as
// src/sh/scrub-inherited-package-dir.ts (imported first by the entry points);
// `bun test` files import pi modules directly without going through an entry,
// so they need the preload instead. Under a session's redirect, source-mode
// pi resolves themes (dist/modes/.../theme/dark.json) and settings.json from
// the session's extraction cache where they do not exist.
import { EMBEDDED_ASSETS_CACHE_MARKER } from "../src/sh/scrub-inherited-package-dir.ts";

const inherited = process.env.PI_PACKAGE_DIR;
if (inherited?.includes(EMBEDDED_ASSETS_CACHE_MARKER)) {
	delete process.env.PI_PACKAGE_DIR;
}
