/**
 * set-package-dir — pin PI_PACKAGE_DIR to the pi-coding-agent location in
 * node_modules so that theme/asset/template paths resolve correctly when
 * running as a bundled .js file.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * pi's getPackageDir() has three effective paths:
 *   - compiled binary (isBunBinary=true): returns dirname(process.execPath)
 *     → assets are copied alongside the exe in scripts/build.ts. No override.
 *   - bundle .js (isBunBinary=false): walks up from __dirname looking for
 *     package.json → finds the monorepo root → tries dist/modes/interactive/theme
 *     which is wrong. Needs PI_PACKAGE_DIR to point at the real pi package.
 *   - source mode (`bun src/cli.ts`): pi resolves its own package location
 *     correctly via the real node_modules tree. No override needed.
 *
 * MODE DETECTION
 * --------------
 * We key off import.meta.url, which reflects how *this module* was loaded:
 *   - source:  .../bun-apps/pi-agent/src/patches/set-package-dir.ts
 *   - bundle:  .../dist/pi-agent/pi-agent.js   (module inlined into the bundle)
 *   - binary:  $bunfs/... or ~BUN/...          (bun's virtual fs scheme)
 *
 * PI_PKG_DIR is a build-time constant written by scripts/build.ts into
 * src/generated/pi-pkg-dir.ts (gitignored — holds a machine-specific path).
 * We load it via a static-literal dynamic import so bun inlines it into the
 * bundle at build time; the try/catch lets source mode run when the file is
 * absent (fresh checkout, no build step).
 */
// Static string literal — bun can trace and bundle this. try/catch covers the
// source-mode case where the generated file does not exist yet.
let PI_PKG_DIR = "";
try {
  // @ts-ignore — generated at build time; absent in a clean source tree
  const mod = await import("../generated/pi-pkg-dir.ts");
  PI_PKG_DIR = mod.PI_PKG_DIR ?? "";
} catch {
  PI_PKG_DIR = "";
}

import { detectMode, type BundlerMode } from "../mode.ts";

const url = import.meta.url;
const mode = detectMode(url, "/src/patches/");

/**
 * Pure decision: should PI_PACKAGE_DIR be set for this mode + path state?
 *
 * Apply ONLY for the bundle .js case: not the binary (assets alongside) and
 * not source mode (pi resolves correctly on its own). Skip when no path was
 * baked in (empty / missing). Exported so the gating logic is unit-testable
 * without importing the module (which would fire the side effect).
 */
export function shouldSetPackageDir(mode: BundlerMode, piPkgDir: string): boolean {
  return mode === "bundle" && !!piPkgDir;
}

// Apply ONLY for the bundle .js case: not the binary (assets alongside) and
// not source mode (pi resolves correctly on its own). Skip when no path was
// baked in (empty / missing) — keeps source mode safe.
if (shouldSetPackageDir(mode, PI_PKG_DIR)) {
  process.env.PI_PACKAGE_DIR ??= PI_PKG_DIR;
}
