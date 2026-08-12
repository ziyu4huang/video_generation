/**
 * mupdf-wasm-locate.ts — make mupdf's 10 MB WASM blob findable in a BUNDLED or
 * COMPILED build. Side-effect-only module; import it BEFORE `mupdf`.
 *
 * The problem
 * -----------
 * mupdf ships `dist/mupdf.js` (JS API) + `dist/mupdf-wasm.js` (emscripten glue)
 * + `dist/mupdf-wasm.wasm` (the engine). The glue locates the `.wasm` with
 *
 *     Module.locateFile ? Module.locateFile("mupdf-wasm.wasm", scriptDir)
 *                       : new URL("mupdf-wasm.wasm", import.meta.url).href
 *
 * and it runs that at MODULE EVAL time (`mupdf.js` does a top-level `await` on
 * the glue factory). Under `bun build`, `import.meta.url` is rewritten to the
 * OUTPUT bundle's location, so the fallback branch looks for the blob next to
 * `pi-agent.js` — where no build stage ever put it:
 *
 *     failed to asynchronously prepare wasm: ENOENT … dist/pi-agent/mupdf-wasm.wasm
 *
 * Any command in the `pi-agent cli` namespace tripped this, not just `file2md`:
 * `src/cli/dispatch.ts` statically imports every command, `file2md` reaches
 * this package, and the glue's top-level await fires on import. (Not a merge
 * regression — the old standalone `dist/pi-agent-cli/cli.js` bundle had the
 * exact same hole.)
 *
 * The fix
 * -------
 * Take the `locateFile` branch instead of the `import.meta.url` one. The glue
 * reads its options object from `globalThis["$libmupdf_wasm_Module"]`, so
 * setting that before mupdf evaluates is enough.
 *
 * The path we hand it comes from a `with { type: "file" }` import, which makes
 * the blob a first-class build input in all three modes we ship:
 *
 *   source  (`bun src/…`)     → absolute path to the real file in node_modules
 *   bundle  (`bun build`)     → blob emitted next to the bundle, value is the
 *                               bundle-relative "./mupdf-wasm-<hash>.wasm"
 *   binary  (`--compile`)     → blob embedded in the exe, value is an absolute
 *                               "/$bunfs/root/mupdf-wasm-<hash>.wasm"
 *
 * so no deploy stage has to know the blob exists. Only the bundle case needs
 * re-anchoring, hence the isAbsolute() branch below.
 *
 * Why the relative node_modules specifier: mupdf's package.json `exports` map
 * declares "." and nothing else, so `mupdf/dist/mupdf-wasm.wasm` does not
 * resolve. The path below reflects bun-apps' isolated linker, which gives each
 * workspace package its own node_modules. If a future install layout moves it,
 * `bun build` fails loudly at build time rather than at runtime.
 */
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — `type: "file"` asset import; resolved by Bun, not by tsc.
import wasmAssetPath from "../../node_modules/mupdf/dist/mupdf-wasm.wasm" with { type: "file" };

/** Absolute, readable path to mupdf-wasm.wasm in the current build mode. */
export const MUPDF_WASM_PATH: string = isAbsolute(wasmAssetPath as string)
  ? (wasmAssetPath as string)
  : fileURLToPath(new URL(wasmAssetPath as string, import.meta.url));

// `??=` so an explicit host override (a caller that pre-set its own emscripten
// Module options) still wins.
(globalThis as any)["$libmupdf_wasm_Module"] ??= { locateFile: () => MUPDF_WASM_PATH };
