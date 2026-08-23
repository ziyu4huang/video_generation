/**
 * The "#pi/ext-dir" imports target — the package root, for source mode
 * (same idiom as s2-agent-ext-archify/src/sh-ext-dir.ts).
 *
 * Loaded ONLY through require("#pi/ext-dir"): in source mode the package.json
 * `imports` map resolves the specifier here, where __dirname is the REAL
 * <pkg>/src dir — so the exported path tracks wherever the package actually
 * lives. In the sh-deploy bundle the specifier is bundler-external and served
 * by the loader's injected require as the DEPLOYED ext/<name>/ dir (a plain
 * string, never this file) — which is exactly what lets runtime code tell the
 * two modes apart. It is deliberately never imported statically: this file
 * must never enter a bundle graph.
 */
import { dirname } from "node:path";

// __dirname here is <pkg>/src (this file's dir); its parent is the package root.
export default dirname(__dirname);
