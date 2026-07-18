/**
 * extract-embedded-assets.ts — runtime extraction patch for the --compile-embed
 * binary mode.
 *
 * Detects whether the current executable has embedded assets (by checking
 * EMBEDDED_ASSETS.length > 0 AND binary mode via import.meta.url's $bunfs
 * scheme). If so, extracts them to:
 *   ~/.pi/agent/embedded-assets/<manifest-hash>/
 *
 * and sets process.env.PI_PACKAGE_DIR to that directory so pi's
 * getThemesDir()/getExportTemplateDir()/getAssetsDir() resolve correctly.
 *
 * Exports computeEmbeddedExtractDir() so run-dir/resolve.ts can compute the
 * SAME cache dir for binary-mode --skill path resolution.
 *
 * Idempotent: a `.extracted` marker file is written after successful extraction.
 * A killed/partial extraction retries on next launch.
 *
 * Performance note: the hash is computed FROM the EMBEDDED_ASSETS array, which
 * is a static literal baked at build time (no I/O). The only I/O is:
 *   1) checking/writing the marker file (one existsSync + writeFileSync)
 *   2) extracting the blobs (one Bun.write per file, ~88 files / ~1.6 MB)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EMBEDDED_ASSETS } from "../generated/embedded-assets.ts";
import { isBunBinary } from "../mode.ts";

const MARKER_FILENAME = ".extracted";

/**
 * Pure: compute the extraction cache dir from the embedded manifest + Bun.version.
 * Deterministic for the same binary — no I/O, no side effects.
 * Returns null when there are no embedded assets.
 */
export function computeEmbeddedExtractDir(): string | null {
  if (EMBEDDED_ASSETS.length === 0) return null;
  // Hash the manifest (relPath list + Bun.version) for cache busting:
  // a rebuilt binary with different assets gets a fresh cache dir.
  const manifestStr = JSON.stringify(EMBEDDED_ASSETS.map((e) => e.relPath)) + "|" + (Bun.version ?? "unknown");
  const hash = createHash("sha256").update(manifestStr).digest("hex").slice(0, 12);
  return join(homedir(), ".pi", "agent", "embedded-assets", hash);
}

/**
 * Check whether the marker file exists inside a given cache dir.
 */
function isAlreadyExtracted(cacheDir: string): boolean {
  return existsSync(join(cacheDir, MARKER_FILENAME));
}

/**
 * Extract all embedded blobs to the cache dir.
 */
async function extractAll(cacheDir: string): Promise<void> {
  mkdirSync(cacheDir, { recursive: true });
  for (const { relPath, blobPath } of EMBEDDED_ASSETS) {
    const dst = join(cacheDir, relPath);
    const parent = dirname(dst);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    await Bun.write(dst, Bun.file(blobPath));
  }
}

/**
 * Write the marker file — signals that extraction completed successfully.
 */
function markExtracted(cacheDir: string): void {
  writeFileSync(join(cacheDir, MARKER_FILENAME), `extracted at ${new Date().toISOString()}\n`);
}

// ── Run at import time (this is a patch — runs during applyPatches()) ───────
if (isBunBinary(import.meta.url) && EMBEDDED_ASSETS.length > 0) {
  const cacheDir = computeEmbeddedExtractDir();
  if (cacheDir && !isAlreadyExtracted(cacheDir)) {
    await extractAll(cacheDir);
    markExtracted(cacheDir);
  }
  // Set PI_PACKAGE_DIR so pi's getThemesDir()/getAssetsDir() resolve here.
  // Uses ??= so an existing explicit override takes precedence.
  process.env.PI_PACKAGE_DIR ??= cacheDir;
  // Also export the extract dir via env var so run-dir/resolve.ts can use it.
  process.env.BUN_PI_EMBEDDED_EXTRACT_DIR = cacheDir ?? "";
}

export const extractEmbeddedAssetsPatchApplied = true;
