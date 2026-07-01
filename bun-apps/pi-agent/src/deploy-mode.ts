/**
 * Deploy-mode self-location for the bundled pi-agent.
 *
 * WHY THIS EXISTS
 *   The deployed package (`scripts/deploy.ts` output) is a self-contained
 *   directory: `pi-agent.js` + `packages/<ext>/…` + `.pi/settings.json` +
 *   `node_modules/`. But pi's resource discovery is **cwd-based** — it loads
 *   extensions and `.pi/` from whatever directory you invoke it in
 *   (`resource-loader.js` does `join(this.cwd, CONFIG_DIR_NAME, …)`).
 *
 *   So `bun /tmp/pkg/pi-agent.js` run from a foreign cwd would:
 *     • ignore the package's baked extensions entirely (pi uses the cwd's
 *       `.pi/settings.json`, or none), and
 *     • trip the source-mode preflight, which walks up from cwd and may latch
 *       onto an *unrelated, uninstalled* pi monorepo (the exact bug this fixes).
 *
 *   This module detects when pi-agent.js is running AS a deployed package and,
 *   when the user invoked it from outside the package dir, re-injects the
 *   baked extensions as explicit `-e <path>` flags so they load regardless of
 *   cwd. It does NOT chdir, so pi still operates on the user's real cwd
 *   (their project) as intended for a portable launcher.
 *
 *   When the user DID `cd` into the package, pi already loads the package's own
 *   `.pi/settings.json` — so we inject nothing (avoiding double-registration)
 *   and let the normal preflight run (it probes the installed package and
 *   passes).
 *
 * DETECTION
 *   Deploy mode = the bundled module's own directory contains BOTH
 *   `.pi/settings.json` and `packages/`. In source mode the module lives at
 *   `…/pi-agent/src/cli.ts` (no such files there) → returns null. Safe.
 *
 *   Only local `packages/<name>` entries are injected (npm: registry packages
 *   are expected to live in the user's global agent dir, e.g.
 *   `~/.pi/agent/npm/…`, which pi loads independently of project settings).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DeployModeResult {
  /** Absolute dir containing the deployed package (and this bundle). */
  selfDir: string;
  /** Flattened argv tokens to prepend, e.g. ["-e", "/a/ext.ts", "-e", "/b/ext.ts"]. */
  extensionArgs: string[];
  /** Always true in deploy mode (we inject + skip preflight regardless of cwd). */
  inject: boolean;
}

/** Tests `#sentinel-deploy-pi-agent` — see scripts/deploy.ts writes the marker. */
const DEPLOY_SENTINEL_FILE = ".pi-deploy-marker.json";

/**
 * Detect deploy mode. Returns null when not running as a deployed package
 * (source mode, or a bundle not sitting in a deploy layout).
 *
 * We ALWAYS inject the baked extensions as `-e` flags and skip the cwd
 * preflight, for two reasons uncovered during testing:
 *   1. pi's resource discovery is cwd-based, so from a foreign cwd the
 *      package's `.pi/settings.json` is never read and baked extensions
 *      wouldn't load.
 *   2. settings-declared packages are `project` scope, which pi only loads
 *      after project TRUST is granted — unavailable in non-interactive runs
 *      and for freshly deployed dirs. `-e` is `temporary` scope (trust-free).
 * Double-registration is not a concern: when cd'd in AND trusted, pi's loader
 * dedupes against the `-e` entries (verified: obsidian_list count stays 1).
 */
export function detectDeployMode(): DeployModeResult | null {
  const selfDir = dirname(fileURLToPath(import.meta.url));

  // Must look like a deploy layout. Require the marker file deploy.ts writes,
  // plus the canonical dirs, so we never false-positive in source mode.
  const markerPath = join(selfDir, DEPLOY_SENTINEL_FILE);
  const settingsPath = join(selfDir, ".pi", "settings.json");
  const packagesDir = join(selfDir, "packages");
  if (!existsSync(markerPath) || !existsSync(settingsPath) || !existsSync(packagesDir)) {
    return null;
  }

  const extensionArgs: string[] = ["-ne"]; // load ONLY our -e paths, skip cwd settings extensions (prevents conflicts when run inside a repo that declares the same extensions)
  const settings = safeJson<{ packages?: string[] }>(settingsPath);
  for (const entry of settings?.packages ?? []) {
    if (entry.startsWith("npm:")) continue; // global agent-dir packages
    // pi resolves project settings entries relative to <cwd>/.pi; mirror that
    // so the same "../packages/<name>" entries resolve to the package dir.
    const pkgDir = join(selfDir, ".pi", entry);
    for (const extTs of resolveExtensionEntries(pkgDir)) {
      extensionArgs.push("-e", extTs);
    }
  }

  return { selfDir, extensionArgs, inject: true };
}

/**
 * Resolve the `.ts` extension entry files a package exposes.
 * Reads the package's `pi.extensions` field (array of dirs; default
 * `["./extensions"]`), lists non-test `.ts` files in each, absolute.
 */
function resolveExtensionEntries(pkgDir: string): string[] {
  if (!existsSync(pkgDir)) return [];
  const pkg = safeJson<{ pi?: { extensions?: string[] } }>(join(pkgDir, "package.json"));
  const extDirs = pkg?.pi?.extensions?.length ? pkg.pi.extensions : ["./extensions"];
  const out: string[] = [];
  for (const rel of extDirs) {
    const dir = join(pkgDir, rel);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (!name.endsWith(".ts")) continue;
      if (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) continue;
      if (name.startsWith("__")) continue;
      out.push(join(dir, name));
    }
  }
  return out;
}

function safeJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
