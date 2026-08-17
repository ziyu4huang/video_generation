/**
 * vendor-mermaid.ts — copy the mermaid UMD bundle from node_modules into the
 * package's gitignored `vendor/` dir at build time.
 *
 * Why a build step (not a committed blob): the mermaid UMD minified bundle is
 * ~3.4 MiB, which exceeds the repo's 2 MB pre-commit guard. We source mermaid
 * from npm (runtime dep) and build-copy it here so NO large binary is ever
 * committed and NO `--no-verify` is ever needed. The converter
 * (`src/architecture-render.ts`) still reads `vendor/mermaid.min.js` at render
 * time — fully offline, zero CDN. Run via `bun run architecture:vendor`
 * (also wired into `build`).
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = join("node_modules", "mermaid", "dist", "mermaid.min.js");
const DEST = join("vendor", "mermaid.min.js");

mkdirSync(dirname(DEST), { recursive: true });
copyFileSync(SRC, DEST);
console.log(`vendored ${SRC} -> ${DEST}`);
