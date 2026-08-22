/**
 * extract-embedded-assets — unit tests for the GC helper only.
 *
 * The import-time side effect (extracting blobs + setting PI_PACKAGE_DIR) only
 * fires in --exe binary mode (isBunBinary(import.meta.url) is false under
 * `bun test`, and EMBEDDED_ASSETS falls back to [] without the build-time
 * generated manifest) — so importing the module here is side-effect-free by
 * construction, same split as ensure-model-tiers.test.ts. GC runs against
 * throwaway temp dirs; nothing touches the live ~/.pi/agent cache.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GC_MAX_AGE_MS, gcStaleExtractDirs } from "./extract-embedded-assets.ts";

const DAY = 24 * 60 * 60 * 1000;
// Fixed "now" so assertions never depend on wall-clock timing.
const NOW = Date.parse("2026-08-22T00:00:00Z");

let root: string;
const exists = (parent: string, name: string) => {
  try {
    statSync(join(parent, name));
    return true;
  } catch {
    return false;
  }
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "eea-gc-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Fresh per-test cache root — tests never share sibling state. */
function freshRoot(): string {
  return mkdtempSync(join(root, "case-"));
}

/** Create a hash-shaped sibling dir with the given age in days. */
function hashDir(parent: string, name: string, ageDays: number) {
  const dir = join(parent, name);
  mkdirSync(dir);
  // mtime is the ONLY freshness signal GC reads — set it explicitly so the
  // test does not race filesystem timestamp granularity.
  utimesSync(dir, new Date(NOW - ageDays * DAY), new Date(NOW - ageDays * DAY));
  return dir;
}

describe("gcStaleExtractDirs — age-based sibling collection", () => {
  test("removes stale hash dirs, keeps fresh ones", () => {
    const caseRoot = freshRoot();
    hashDir(caseRoot, "aaaa00000001", 45); // stale (> 30d)
    hashDir(caseRoot, "bbbb00000002", 3); // fresh
    const removed = gcStaleExtractDirs(caseRoot, join(caseRoot, "cccc00000003"), NOW);
    expect(removed).toEqual(["aaaa00000001"]);
    expect(exists(caseRoot, "aaaa00000001")).toBe(false);
    expect(exists(caseRoot, "bbbb00000002")).toBe(true);
  });

  test("never removes keepDir itself, however stale", () => {
    const caseRoot = freshRoot();
    const keep = hashDir(caseRoot, "dddd00000004", 400); // way past max age
    const removed = gcStaleExtractDirs(caseRoot, keep, NOW);
    expect(removed).toEqual([]);
    expect(exists(caseRoot, "dddd00000004")).toBe(true);
  });

  test("boundary: exactly maxAgeMs old is KEPT (strictly-greater deletes)", () => {
    const caseRoot = freshRoot();
    const boundary = Math.floor(GC_MAX_AGE_MS / DAY);
    hashDir(caseRoot, "eeee00000005", boundary);
    const removed = gcStaleExtractDirs(caseRoot, join(caseRoot, "ffff00000006"), NOW);
    expect(removed).toEqual([]);
    expect(exists(caseRoot, "eeee00000005")).toBe(true);
  });

  test("ignores non-hash-shaped names and plain files, however stale", () => {
    const caseRoot = freshRoot();
    hashDir(caseRoot, "not-a-hash-dir", 90);
    hashDir(caseRoot, "ABCDEF123456", 90); // uppercase — not the lowercase hex GC emits
    const staleFile = join(caseRoot, "0123456789ab");
    writeFileSync(staleFile, "x");
    utimesSync(staleFile, new Date(NOW - 90 * DAY), new Date(NOW - 90 * DAY));
    const removed = gcStaleExtractDirs(caseRoot, join(caseRoot, "ffff00000006"), NOW);
    expect(removed).toEqual([]);
    expect(exists(caseRoot, "not-a-hash-dir")).toBe(true);
    expect(exists(caseRoot, "ABCDEF123456")).toBe(true);
    expect(exists(caseRoot, "0123456789ab")).toBe(true);
  });

  test("missing parent dir → no throw, empty result", () => {
    const caseRoot = freshRoot();
    expect(
      gcStaleExtractDirs(join(caseRoot, "does-not-exist"), join(caseRoot, "ffff00000006"), NOW),
    ).toEqual([]);
  });
});
