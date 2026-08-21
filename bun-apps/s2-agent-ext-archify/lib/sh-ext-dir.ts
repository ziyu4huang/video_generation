/**
 * The "#pi/ext-dir" imports target — the package root, for jiti/source mode
 * (same idiom as s2-agent-ext-obsidian/src/sh-ext-dir.ts).
 *
 * Loaded ONLY through require("#pi/ext-dir"): jiti/bun compile this to cjs
 * with the REAL __dirname, so the exported path tracks wherever the package
 * actually lives. It is deliberately never imported statically by lib/run.ts —
 * in the sh-deploy bundle, `#pi/ext-dir` is served by the loader's injected
 * require (the deployed ext dir, where vendored/ is copied beside ext.cjs),
 * and this file never enters the bundle graph at all.
 */
import { dirname } from "node:path";

// __dirname here is <pkg>/lib (this file's dir); its parent is the package root.
export default dirname(__dirname);
