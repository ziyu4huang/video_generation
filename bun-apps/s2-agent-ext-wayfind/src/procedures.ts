import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path to a bundled procedure file under `<pkg>/procedures/`.
 *
 * Procedures live OUTSIDE `skills/` on purpose: pi auto-registers every
 * `skills/` entry as a user-invocable `/skill:<name>` slash command, which
 * duplicates the `/wayfind` command. Moving the wayfinder procedure here keeps it
 * loadable on demand by the command that needs it, without surfacing a redundant
 * slash entry. See `commands.ts` (handleWayfinderChart) for the call site.
 *
 * Resolution order (deliberately NOT `import.meta.url` by default: bun's cjs
 * bundler folds that into a build-machine path literal — rejected by the sh
 * deploy's relocatability gate — and REBINDS `__dirname` to the build machine
 * as well, so the sh loader serves the deployed dir through the injected
 * require instead):
 *   1. `fromUrl` injected (tests / callers with a real module URL) →
 *      `src/procedures.ts → ../procedures`.
 *   2. sh deploy: `require("#pi/ext-dir")` → the deploy copies `procedures/`
 *      beside the bundle (ext/<name>/procedures).
 *   3. jiti/source and dist: the package.json `"#pi/ext-dir"` imports entry
 *      (`src/sh-ext-dir.ts`, loaded by jiti as cjs with the REAL `__dirname`)
 *      → the package root, where `procedures/` lives.
 */
const EXT_DIR_SPEC = "#pi/ext-dir";

function shExtDir(): string | undefined {
  try {
    if (typeof require === "function") {
      const mod = require(EXT_DIR_SPEC) as { default?: unknown } | string;
      if (typeof mod === "string") return mod; // sh loader: the deployed ext dir
      if (mod !== null && typeof mod === "object" && typeof mod.default === "string") {
        return mod.default; // jiti/source: package.json "#pi/ext-dir" imports entry
      }
    }
  } catch {
    // Not resolvable here (native ESM / tests) — fall through.
  }
  return undefined;
}

export function procedurePath(name: string, fromUrl?: string): string {
  if (fromUrl !== undefined) {
    // procedures.ts is at <pkg>/src/procedures.ts → procedures/ is ../procedures/
    return resolve(dirname(fileURLToPath(fromUrl)), "..", "procedures", `${name}.md`);
  }
  const extDir = shExtDir();
  if (extDir !== undefined) return join(extDir, "procedures", `${name}.md`);
  // Nothing located (native ESM without a resolvable #pi/ext-dir) — return a
  // cwd-relative path and let the caller's read error surface.
  return resolve(".", "procedures", `${name}.md`);
}
