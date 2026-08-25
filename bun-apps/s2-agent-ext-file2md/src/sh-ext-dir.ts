/**
 * The "#pi/ext-dir" imports target — the package root, for jiti/source mode
 * (same idiom as s2-agent-ext-archify/src/sh-ext-dir.ts).
 *
 * Loaded ONLY through require("#pi/ext-dir"): jiti/bun compile this to cjs
 * with the REAL __dirname, so the exported path tracks wherever the package
 * actually lives. In the sh-deploy bundle the loader's injected require serves
 * the deployed ext dir instead (where vendored/ is copied beside ext.cjs), and
 * this file never enters the bundle graph at all.
 */
import { dirname } from "node:path";

// __dirname here is <pkg>/src (this file's dir); its parent is the package root.
export default dirname(__dirname);
