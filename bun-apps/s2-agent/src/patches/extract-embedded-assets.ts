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
 * It ALSO mirrors the deploy dir's package.json into the cache: pi reads
 * VERSION / APP_NAME / CONFIG_DIR_NAME from <getPackageDir()>/package.json
 * and getPackageDir() honors PI_PACKAGE_DIR, so the redirect alone made every
 * deployed binary report VERSION "0.0.0" and APP_NAME "pi".
 *
 * Exports computeEmbeddedExtractDir() so run-dir/resolve.ts can compute the
 * SAME cache dir for binary-mode --skill path resolution.
 *
 * Idempotent: a `.extracted` marker file is written after successful extraction.
 * A killed/partial extraction retries on next launch.
 *
 * GC: cache dirs are keyed by (asset manifest + Bun.version) — NOT deploy
 * version — so every Bun upgrade or asset-set change orphans the previous
 * hash dir forever. gcStaleExtractDirs() (below) deletes sibling dirs whose
 * mtime is older than GC_MAX_AGE_MS. mtime is the freshness signal because
 * the package.json mirror below rewrites (tmp+rename) on EVERY boot, which
 * refreshes the live dir's mtime; an abandoned hash goes quietly stale.
 * Age-based (not keep:N) so a hash still booted by an older dist deploy or an
 * e2e run is never yanked out from under a concurrently-running binary.
 *
 * Performance note: the hash is computed FROM the EMBEDDED_ASSETS array, which
 * is a static literal baked at build time (no I/O). The only I/O is:
 *   1) checking/writing the marker file (one existsSync + writeFileSync)
 *   2) extracting the blobs (one Bun.write per file, ~88 files / ~1.6 MB)
 *   3) the GC scan (one readdirSync + one statSync per sibling — binary mode only)
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isBunBinary } from "../mode.ts";

// src/generated/embedded-assets.ts is build-time-generated + gitignored (same
// convention as pi-pkg-dir.ts / run-dir-base.ts) — absent on a fresh checkout
// until a deploy codegen step runs. Dynamic import + fallback (the same
// pattern run-dir/resolve.ts's loadRunDirBase() already uses for the other
// two generated files) so a fresh clone / plain `bun test` / `bun src/cli.ts`
// never crashes on the missing file. A static top-level import here would
// hard-fail module resolution with no way to catch it. Falling back to []
// degrades to exactly what a real (non---exe) build's generated file already
// contains anyway — stageGenerateEmbeddedAssets() writes an "empty manifest"
// for every mode except --exe.
async function loadEmbeddedAssets(): Promise<Array<{ relPath: string; blobPath: string }>> {
  try {
    // @ts-ignore — generated at build time; absent in a clean source tree
    const mod = await import("../generated/embedded-assets.ts");
    return mod.EMBEDDED_ASSETS ?? [];
  } catch {
    return [];
  }
}

const EMBEDDED_ASSETS = await loadEmbeddedAssets();

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

/** Delete sibling cache dirs untouched for longer than this. See file header. */
export const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Garbage-collect stale extraction cache dirs (binary-mode boot only).
 *
 * Deletes sibling directories of keepDir whose name looks like a manifest hash
 * (12 lowercase hex — computeEmbeddedExtractDir's slice(0, 12)) AND whose mtime
 * is older than maxAgeMs. Never touches keepDir itself, non-hash-shaped names,
 * or plain files — anything unexpected in the cache root is left alone.
 *
 * Best-effort by construction: a missing parentDir returns [], and any per-entry
 * failure (stat/rm) skips that entry — a cache cleanup must never kill boot.
 * Returns the names removed (for tests + debug).
 */
export function gcStaleExtractDirs(
  parentDir: string,
  keepDir: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = GC_MAX_AGE_MS,
): string[] {
  const keepName = basename(keepDir);
  const removed: string[] = [];
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return removed; // absent (or unreadable) cache root — nothing to collect
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === keepName) continue;
    if (!/^[0-9a-f]{12}$/.test(entry.name)) continue;
    try {
      const mtimeMs = statSync(join(parentDir, entry.name)).mtimeMs;
      if (nowMs - mtimeMs <= maxAgeMs) continue;
      rmSync(join(parentDir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // skip this entry; GC is advisory
    }
  }
  return removed;
}

// ── Run at import time (this is a patch — runs during applyPatches()) ───────
if (isBunBinary(import.meta.url) && EMBEDDED_ASSETS.length > 0) {
  const cacheDir = computeEmbeddedExtractDir();
  if (cacheDir && !isAlreadyExtracted(cacheDir)) {
    await extractAll(cacheDir);
    markExtracted(cacheDir);
  }
  // Mirror the deploy dir's package.json (version + piConfig) into the cache
  // so the PI_PACKAGE_DIR redirect below does not break version/branding
  // resolution (deploy-e2e.test.ts asserts --version == the deploy version).
  // Written on EVERY boot — unconditionally and outside the marker check:
  // the cache dir is keyed by the asset manifest hash + Bun.version and is
  // REUSED across deploy versions, so a copy made once at extraction time
  // would go stale the moment a newer deploy shares the same hash.
  // Atomic tmp+rename, NOT copyFileSync: copyfile(2) propagates the frozen
  // deploy tree's read-only (444) mode onto the destination, and every later
  // boot's overwrite then fails EACCES — an unhandled module-init exception
  // that kills the binary. rename only needs write on the cache DIR; a
  // concurrent reader sees either the old or the new file, never a partial
  // JSON (config.js rethrows parse errors, so a torn write would crash pi).
  // Any failure here degrades to pi's pre-existing fallback (VERSION "0.0.0")
  // instead of taking boot down — never let a cache-dir hiccup kill startup.
  const deployPkgJson = join(dirname(process.execPath), "package.json");
  if (cacheDir && existsSync(deployPkgJson)) {
    const dst = join(cacheDir, "package.json");
    const tmp = `${dst}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, readFileSync(deployPkgJson, "utf8"), { mode: 0o644 });
      renameSync(tmp, dst);
    } catch {
      rmSync(tmp, { force: true });
    }
  }
  // Set PI_PACKAGE_DIR so pi's getThemesDir()/getAssetsDir() resolve here.
  // Uses ??= so an existing explicit override takes precedence. cacheDir is
  // guaranteed non-null here: computeEmbeddedExtractDir() only returns null
  // when EMBEDDED_ASSETS is empty, already ruled out by the outer `if`.
  process.env.PI_PACKAGE_DIR ??= cacheDir!;
  // Also export the extract dir via env var so run-dir/resolve.ts can use it.
  process.env.BUN_PI_EMBEDDED_EXTRACT_DIR = cacheDir ?? "";
  // GC stale sibling hash dirs. Runs AFTER the package.json mirror above: that
  // tmp+rename is what refreshes THIS dir's mtime on every boot, and mtime is
  // the freshness signal gcStaleExtractDirs keys on. (keepDir is also excluded
  // by name, so the ordering is belt-and-braces, not load-bearing.) Never
  // throws — see gcStaleExtractDirs.
  gcStaleExtractDirs(dirname(cacheDir!), cacheDir!);
}
