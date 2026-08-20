/**
 * Used-detection trigger — the "used vs dropped" half of prompt provenance
 * (UPSP §9 / ticket #06, Task 5).
 *
 * Pairs with SessionRepository.markUsed (the DB stamp from Tasks 3/4). At
 * `message_end` (role === 'assistant') we accumulate the turn's assistant
 * output into a per-turn buffer. At `turn_end` we scan that buffer ONCE against
 * the per-session `SurfacedSignatureSet` (populated at session_start by Task 6
 * from the SAME prompt-assembly receipt #05 recorded, so the §5↔§9 join stays
 * intact): any surfaced signature that substring-matches the normalized buffer
 * is "used" — we collect its mdId and FORGET the signature (monotonic: once
 * used, never re-detected → idempotent `markUsed`).
 *
 * Best-effort at every level, fully try/catch-wrapped — never blocks the turn.
 * Mirrors worth-scoring's safety envelope exactly. DB-authoritative (no .md
 * write-through). DISTINCT from worth-scoring: that tracks *recalled*
 * (memory_search) memory + turn outcome; this tracks *surfaced*
 * (prompt-injected) memory the agent's output actually referenced. Gated on
 * `config.usedDetection !== false` (default on), INDEPENDENT of
 * `config.worthScoring`.
 *
 * The matcher reuses the SINGLE shared normalization (`normalizeForSignature`
 * from signature.ts) so a signature produced by `computeSignature` is, by
 * construction, a substring of the same text run through `normalizeForSignature`
 * — the two sides can never drift out of agreement.
 *
 * NOT wired here — Task 6 constructs the set, calls `setupUsedDetection` once
 * at extension setup, and `populate`s at `session_start`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionRepository } from "../store/repository.js";
import type { MemoryConfig } from "../types.js";
import { normalizeForSignature } from "../store/signature.js";
import { getMessageText } from "../types.js";

/**
 * Per-session map of surfaced-entry signature → mdId. Populated once at
 * `session_start` (Task 6) from the same prompt-assembly receipt #05 recorded.
 * Matching is MONOTONIC: once a signature matches the turn's normalized
 * assistant output, it is removed from the map — a later turn cannot
 * re-detect (and thus cannot re-mark) the same entry. Unmatched signatures
 * remain for future turns.
 *
 * Mirrors worth-scoring's `RecallSet` shape (a small per-session holder), but
 * keyed by signature string (the surfaced/injected set) instead of memory id
 * (the recalled/searched set).
 */
export class SurfacedSignatureSet {
  private readonly signatures = new Map<string, string>();

  /** Replace the whole map. Called once at `session_start` (Task 6). Clears
   *  then sets — a re-populate fully replaces (no stale carryover). */
  populate(entries: ReadonlyArray<{ mdId: string; signature: string }>): void {
    this.signatures.clear();
    for (const { mdId, signature } of entries) {
      if (signature) this.signatures.set(signature, mdId);
    }
  }

  /**
   * Scan `normalizedText` for each REMAINING signature. For every signature
   * that is a substring of the text, collect its mdId AND delete the signature
   * from the map (monotonic forget). Returns the matched mdIds (map insertion
   * order). Unmatched signatures STAY in the map for future turns. An empty /
   * whitespace text matches nothing and mutates nothing.
   */
  matchAndForget(normalizedText: string): string[] {
    if (!normalizedText) return [];
    const matched: string[] = [];
    for (const [signature, mdId] of this.signatures) {
      if (normalizedText.includes(signature)) {
        matched.push(mdId);
        this.signatures.delete(signature);
      }
    }
    return matched;
  }
}

/**
 * Wire used-detection: buffer the turn's assistant output, then at `turn_end`
 * scan it against the surfaced signatures and `markUsed` the matched rows.
 *
 * `message_end` is gated on `enabled = config.usedDetection !== false` and
 * `role === 'assistant'`; `getMessageText` is called with a large `maxLength`
 * (100_000) because the default 500 truncates long assistant messages and a
 * ≥`usedSignatureMinChars` signature could live past char 500. `turn_end` is
 * fully try/catch-wrapped (a throwing `normalizeForSignature`/`getSessionId`/
 * `markUsed` is swallowed) — the turn is NEVER blocked. When disabled, the
 * buffer stays empty so `turn_end` is an effective no-op (no matches, no
 * mutation, no `markUsed`).
 */
export function setupUsedDetection(
  pi: ExtensionAPI,
  sessionRepo: SessionRepository | null,
  surfacedSignatures: SurfacedSignatureSet,
  config: MemoryConfig,
  getSessionId: () => string | null,
): void {
  const enabled = config.usedDetection !== false;
  let turnText = "";

  pi.on("message_end", async (event) => {
    try {
      if (!enabled) return;
      if (event.message.role !== "assistant") return;
      const text = getMessageText(event.message, 100_000);
      if (text) turnText += text;
    } catch {
      // Best-effort — never block the session
    }
  });

  pi.on("turn_end", async () => {
    try {
      const text = turnText;
      turnText = "";
      const matched = surfacedSignatures.matchAndForget(normalizeForSignature(text));
      if (matched.length === 0) return;
      let sid: string | null;
      try {
        sid = getSessionId();
      } catch {
        return; // best-effort — never block
      }
      if (!sid || !sessionRepo) return;
      try {
        await sessionRepo.markUsed(sid, matched, new Date().toISOString());
      } catch {
        // best-effort — never block the session
      }
    } catch {
      // never block the session
    }
  });
}
