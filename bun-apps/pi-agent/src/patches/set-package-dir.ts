/**
 * set-package-dir — pin PI_PACKAGE_DIR to the pi-coding-agent location in
 * node_modules so that theme/asset/template paths resolve correctly when
 * running as a bundled .js file.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * pi's getPackageDir() has two paths:
 *   - compiled binary (isBunBinary=true): returns dirname(process.execPath)
 *     → we copy asset dirs there in the build script (scripts/build.ts)
 *   - bundle .js (isBunBinary=false): walks up from __dirname looking for
 *     package.json → finds the monorepo root → tries dist/modes/interactive/theme
 *     which is wrong.
 *
 * Setting PI_PACKAGE_DIR points getPackageDir() to the real pi-coding-agent
 * package inside node_modules, where all assets actually live.
 *
 * NOTE: PI_PKG_DIR is a build-time constant written by scripts/build.ts.
 * It is NOT present in the source tree — run `bun scripts/build.ts` first.
 * The generated file is gitignored (src/generated/.gitignore).
 */
// @ts-ignore — generated at build time; missing in source tree (pre-build)
import { PI_PKG_DIR } from "../generated/pi-pkg-dir.ts";

// Only override for the bundle case. The compiled binary uses dirname(process.execPath)
// (already handled by bun's isBunBinary detection) and has assets copied alongside it.
const isBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");
if (!isBinary) {
  process.env.PI_PACKAGE_DIR ??= PI_PKG_DIR;
}

export const setPackageDirPatchApplied = true;
