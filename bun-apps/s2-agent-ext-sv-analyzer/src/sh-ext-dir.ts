/**
 * The `#pi/ext-dir` imports entry — resolves to THIS package's root.
 *
 * Loaded ONLY through `require("#pi/ext-dir")` (or the sh-deploy loader's
 * injected require): in source mode / jiti / bun test the package.json
 * `imports` entry is compiled to cjs with the REAL `__dirname`, so the
 * exported path tracks wherever the package actually lives. It is deliberately
 * never imported statically by src/analyzer.ts — in the sh-deploy bundle,
 * `#pi/ext-dir` is served by the loader's injected require (the deployed ext
 * dir, where `wasm/` is copied beside ext.cjs by the registry's
 * `copy: [wasm]`), and this file never enters the bundle graph at all.
 *
 * `__dirname` here is <pkg>/src (this file's dir); its parent is the package
 * root — the same shape as archify's lib/sh-ext-dir.ts and obsidian's
 * src/sh-ext-dir.ts.
 */
import { dirname } from "node:path";

export default dirname(__dirname);
