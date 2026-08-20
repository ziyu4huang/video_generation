/**
 * skip-update-check — silence pi's "Update Available / Run pi update" banner.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * pi's version check (utils/version-check.js) fetches https://pi.dev/api/latest-version
 * on startup and, if a newer release exists, prints an "Update Available" banner
 * prompting `pi update`. For a pi-agent bundle/binary this is meaningless:
 *   - the artifact is our own build, not the upstream npm `pi` package;
 *   - `pi update` would update the wrong thing (or fail);
 *   - the version string already reads `v0.0.0` (no package.json in the bundle).
 *
 * Setting PI_SKIP_VERSION_CHECK=1 makes getLatestPiRelease() return undefined
 * immediately — no fetch, no banner. (PI_OFFLINE has the same effect.)
 *
 * MODE GATING
 * -----------
 * Applied only to shipped artifacts (bundle .js + compiled binary). Source mode
 * (`bun src/cli.ts`) is left alone so dev still sees upstream pi updates.
 * Detection mirrors set-package-dir: import.meta.url reveals how this module
 * was loaded.
 */
import { detectMode, type BundlerMode } from "../mode.ts";

const url = import.meta.url;
const mode = detectMode(url);

/**
 * Pure decision: should the update-check skip be applied for this mode?
 *
 * Applied only to a shipped artifact — which, since the bundle mode was retired
 * in Phase 1b, means the compiled binary. Source mode (`bun src/cli.ts`) is
 * left alone so dev still sees upstream pi updates. Exported so the gating
 * logic is unit-testable without importing the module (which would fire the
 * side effect).
 */
export function shouldSkipUpdateCheck(mode: BundlerMode): boolean {
  return mode === "binary";
}

const isShippedArtifact = shouldSkipUpdateCheck(mode);
const debug = process.env.BUN_PI_DEBUG_PATCHES === "1" ||
  process.env.BUN_PI_DEBUG_PATCHES === "true";

if (isShippedArtifact) {
  // Respect an explicit user choice either way.
  process.env.PI_SKIP_VERSION_CHECK ??= "1";
}

// Debug: confirm mode detection + env state. (We can't call pi's
// getLatestPiRelease() here to prove the skip — the deep subpath isn't in the
// package exports and won't resolve from the bundle. Verified separately.)
if (debug) {
  const skip = process.env.PI_SKIP_VERSION_CHECK;
  console.error(
    `[skip-update-check] mode=${mode} PI_SKIP_VERSION_CHECK=${JSON.stringify(skip)}` +
    (isShippedArtifact ? "" : " (source mode — not forced)"),
  );
}
