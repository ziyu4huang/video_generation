/**
 * One-time deterministic canonicalization of the failure backlog (wayfind
 * 2026-08-05, tickets 04/05/06). Mirrors project-memory-migration.ts: pure fs
 * read/write, result struct, no LLM → auditable before/after diff.
 *
 * Compresses resolved/stale survivors to a one-line canonical fact. Active
 * unique entries are never touched.
 *
 * `.md`-first: operates on the markdown source-of-truth. NOTE — this is a
 * `.md`-ONLY operation: it does NOT reconcile the DB. The startup mirror
 * (syncMarkdownMemories) only upserts by content key (no DELETE), so
 * consumed/compressed entries leave stale DB rows (still surfaced by
 * memory_search) until a separate purge. The 40K budget IS correctly reduced
 * because it is computed from the `.md`.
 * Always dry-run first; the agent confirms the diff before an apply with backup.
 */
import * as fs from "node:fs";
import { ENTRY_DELIMITER } from "./constants.js";
import { splitMemoryEntries } from "./merge-union.js";
import { parseMarkdownMemoryEntry, serializeMetadataComment, today } from "./store/memory-format.js";

export interface FailureModelMigrationResult {
  scanned: number;
  compressed: number;
  dropped: number;
  finalChars: number;
  warnings: string[];
  diff: string;
}

const RESOLVED_MARKER_RE = /\b(resolved|RESOLVED|superseded|fixed|now (works|merges|succeeds))\b/i;
const COMPRESS_MAX_CHARS = 120;

function readEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];
  return splitMemoryEntries(raw);
}

function compressToFact(raw: string): string {
  const parsed = parseMarkdownMemoryEntry(raw, "failure");
  const body = parsed.content.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
  const firstSentence = body.split(/[.—]/)[0]?.trim() ?? body;
  const capped = firstSentence.length > COMPRESS_MAX_CHARS
    ? firstSentence.slice(0, COMPRESS_MAX_CHARS - 1) + "…"
    : firstSentence;
  return serializeMetadataComment({
    text: `[${parsed.category ?? "failure"}] ${capped} (resolved/compressed)`,
    created: parsed.created ?? today(),
    lastReferenced: today(),
  });
}

export function canonicalizeFailureBacklog(opts: {
  failuresPath: string;
  dryRun: boolean;
  backup?: boolean;
}): FailureModelMigrationResult {
  const result: FailureModelMigrationResult = {
    scanned: 0,
    compressed: 0, dropped: 0, finalChars: 0, warnings: [], diff: "",
  };

  const original = readEntries(opts.failuresPath);
  result.scanned = original.length;
  if (original.length === 0) {
    result.diff = "(empty store — nothing to canonicalize)";
    return result;
  }
  const before = original.join(ENTRY_DELIMITER);

  // Compress resolved/stale entries to a one-line canonical fact.
  const finalEntries = original.map((raw) => {
    const parsed = parseMarkdownMemoryEntry(raw, "failure");
    const isResolved = parsed.state === "resolved" || RESOLVED_MARKER_RE.test(parsed.content);
    if (!isResolved) return raw;
    result.compressed++;
    return compressToFact(raw);
  });

  const after = finalEntries.join(ENTRY_DELIMITER);
  result.finalChars = after.length;

  result.diff =
    `--- before (${before.length} chars, ${original.length} entries)\n` +
    `+++ after (${after.length} chars, ${finalEntries.length} entries)\n` +
    `compressed: ${result.compressed} | dropped: ${result.dropped}\n\n` +
    after;

  if (!opts.dryRun) {
    if (opts.backup) fs.writeFileSync(opts.failuresPath + ".bak", before, "utf-8");
    try {
      fs.writeFileSync(opts.failuresPath, after, "utf-8");
    } catch (err) {
      result.warnings.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
