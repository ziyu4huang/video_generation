/**
 * assets.ts — resolve file2md's wasm/lang payloads across dev and deploy.
 *
 * Two layouts, probed in order:
 *
 *   1. sh deploy: the registry `assets:` block copies each payload byte-for-byte
 *      from its npm package under <extDir>/vendored/… (NO node_modules tree
 *      ships — all JS bundles into ext.cjs; user directive 2026-08-25).
 *   2. dev (bun test / source mode): the same files inside the workspace's
 *      npm install, located by package resolution.
 *
 * Every resolver returns undefined (never throws) when neither layout has the
 * payload — the OCR/raster layers degrade to an explicit notice, mirroring the
 * package-wide degrade-not-fail contract.
 *
 * Bundler note: npm fallbacks resolve specifiers through NON-LITERAL
 * `require.resolve(\`…\`)` calls. A literal `require.resolve("pkg/x")` of an
 * INLINED package would be rewritten by bun's bundler to a build-machine path
 * (the Gate 4 defect class); the template form survives as a runtime call.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The deployed ext dir (vendored/ beside ext.cjs), or the package root in dev —
 * the `#pi/ext-dir` idiom (archify/src/sh-ext-dir.ts reference form).
 * Deliberately NOT import.meta.url: bun's cjs bundler folds it to a
 * build-machine path literal, which the deploy's relocatability gate rejects.
 */
function shExtDir(): string | undefined {
  try {
    if (typeof require === "function") {
      const mod = require("#pi/ext-dir") as { default?: unknown } | string;
      if (typeof mod === "string") return mod; // sh loader: the deployed ext dir
      if (mod !== null && typeof mod === "object" && typeof mod.default === "string") {
        return mod.default; // package.json imports entry: the package root
      }
    }
  } catch {
    // Not resolvable here — fall through to the npm layout.
  }
  return undefined;
}

/** An npm package's real directory in the workspace install, or undefined. */
function npmPkgDir(spec: string): string | undefined {
  try {
    // Non-literal on purpose — see the module doc's bundler note.
    return dirname(require.resolve(`${spec}/package.json`));
  } catch {
    return undefined;
  }
}

/** First existing path among candidates; undefined when none exist. */
function firstExisting(...candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (c !== undefined && existsSync(c)) return c;
  }
  return undefined;
}

/** The tesseract-wasm core (deploy: vendored/; dev: the npm package's dist/). */
export function tesseractWasmPath(extDir: string | undefined = shExtDir()): string | undefined {
  const pkg = npmPkgDir("tesseract-wasm");
  return firstExisting(
    extDir !== undefined ? join(extDir, "vendored", "tesseract-wasm", "tesseract-core.wasm") : undefined,
    pkg !== undefined ? join(pkg, "dist", "tesseract-core.wasm") : undefined,
  );
}

/** The pdfium wasm core (deploy: vendored/pdfium/; dev: the npm package's dist/). */
export function pdfiumWasmPath(extDir: string | undefined = shExtDir()): string | undefined {
  const pkg = npmPkgDir("@hyzyla/pdfium");
  return firstExisting(
    extDir !== undefined ? join(extDir, "vendored", "pdfium", "pdfium.wasm") : undefined,
    pkg !== undefined ? join(pkg, "dist", "pdfium.wasm") : undefined,
  );
}

/**
 * One lang part's gzipped `.traineddata` (deploy: vendored/tessdata/; dev: the
 * @tesseract.js-data npm package's 4.0.0_best_int dir).
 */
export function tessdataPath(part: string, extDir: string | undefined = shExtDir()): string | undefined {
  const pkg = npmPkgDir(`@tesseract.js-data/${part}`);
  return firstExisting(
    extDir !== undefined ? join(extDir, "vendored", "tessdata", `${part}.traineddata.gz`) : undefined,
    pkg !== undefined ? join(pkg, "4.0.0_best_int", `${part}.traineddata.gz`) : undefined,
  );
}

/**
 * One pdfjs asset dir — "wasm" | "standard_fonts" | "cmaps" | "iccs" — with a
 * TRAILING separator, the concatenating form pdfjs's getDocument params expect
 * (`${wasmUrl}jbig2.wasm`; NodeBinaryDataFactory fs.readFile's the result).
 * Undefined when neither layout has the dir: pdfjs then falls back to its
 * built-in behavior (the asset-heavy path degrades, text extraction does not).
 */
export function pdfjsAssetDirUrl(
  sub: "wasm" | "standard_fonts" | "cmaps" | "iccs",
  extDir: string | undefined = shExtDir(),
): string | undefined {
  const pkg = npmPkgDir("pdfjs-dist");
  const dir = firstExisting(
    extDir !== undefined ? join(extDir, "vendored", "pdfjs", sub) : undefined,
    pkg !== undefined ? join(pkg, sub) : undefined,
  );
  return dir !== undefined ? `${dir}/` : undefined;
}
