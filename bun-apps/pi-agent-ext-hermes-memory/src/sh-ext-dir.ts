/**
 * The "#pi/ext-dir" imports target — the package root, for jiti/source mode.
 *
 * Loaded ONLY through require("#pi/ext-dir"): jiti compiles it to cjs where
 * `__dirname` is the REAL module dir (`src/` → package root one level up). In
 * the sh deploy the specifier is build-external and the loader intercepts it
 * instead, so this file never runs (and never gets bundled — referencing
 * `__dirname` in bundled code makes bun bake the build machine's path, which
 * the relocatability gate rejects). Under native ESM (bun test) `__dirname` is
 * undefined and the default export is undefined; callers treat that as "not
 * resolvable here" and fall through to their injected-URL path.
 */
import { resolve } from "node:path";

export default typeof __dirname === "string" ? resolve(__dirname, "..") : undefined;
