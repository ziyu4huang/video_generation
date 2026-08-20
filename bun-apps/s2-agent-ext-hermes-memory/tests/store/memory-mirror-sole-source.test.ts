/**
 * Memory-mirror sole-source gate (kp13 Wave B).
 *
 * The plan's Wave B gate: ZERO `syncMemoryEntry` / `replaceSyncedMemories` /
 * `removeSyncedMemories` calls on the memory-kind writer paths — the mirror
 * target is the bundle CardStore (md_id-keyed upsert/update/delete via
 * `memory-card-mirror.ts`), and md stays canonical. The legacy sync* methods
 * STAY on the `MemoryRepository` interface (sessions + non-memory uses call
 * them), so this greps the WRITER files, not the interface or its
 * implementations.
 *
 * Referenced by `src/store/memory-card-mirror.ts`'s header docstring.
 */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The Wave B writer surface: every file whose memory-kind mirror was
 *  re-pointed to the card store (plan 13-three-waves.md, Wave B file list)
 *  plus the mirror helper itself. */
const WRITER_FILES = [
  "src/tools/memory-tool.ts",
  "src/tools/memory-supersede-tool.ts",
  "src/tools/grill-decision-tool.ts",
  "src/handlers/correction-detector.ts",
  "src/handlers/error-detector.ts",
  "src/handlers/sync-markdown-memories.ts",
  "src/handlers/review-memory-ops.ts",
  "src/handlers/background-review.ts",
  "src/store/memory-card-mirror.ts",
  "src/index.ts",
];

/** A live call site: `repo.syncMemoryEntry(`, `.replaceSyncedMemories(`, … —
 *  comment/doc mentions are allowed (they document the retirement). Wave C
 *  adds `removeByMdId` (the retired eviction seam). */
const LIVE_CALL = /\.(syncMemoryEntry|replaceSyncedMemories|removeSyncedMemories|syncMemoryEntriesBatch|removeByMdId)\s*\(/;

describe("memory-mirror sole-source gate (kp13 Wave B + Wave C)", () => {
  for (const rel of WRITER_FILES) {
    it(`${rel}: no live legacy sync* mirror calls`, () => {
      const src = readFileSync(join(pkgRoot, rel), "utf-8");
      // Strip block + line comments so doc mentions don't trip the gate.
      const codeOnly = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const hits = codeOnly.split("\n").filter((l) => LIVE_CALL.test(l));
      assert.deepEqual(
        hits,
        [],
        `${rel} must mirror through the CardStore (memory-card-mirror.ts), not the legacy repo sync* seam; offending lines: ${JSON.stringify(hits)}`,
      );
    });
  }
});
