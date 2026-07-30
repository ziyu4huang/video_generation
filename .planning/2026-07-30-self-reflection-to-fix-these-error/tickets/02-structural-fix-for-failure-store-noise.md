## Question

Apply a **structural** fix that makes the failure-store-noise cluster (near-duplication / re-bloat) stop recurring — an automated check, not another manual dedup pass.

Scope graduates from ticket 00's root-cause. Likely shape (confirm against 00 before building): an automated near-dup detector — either at write time (check-before-save, blocks a near-duplicate entry) or as a CI/periodic compaction that flags high-similarity entries. The exact mechanism is ticket 00's output. Must coexist with the harness lock (use the `memory` API, not raw `.md` surgery during live sessions — see `pi-memory-bulk-dedup` pitfall #6).

**Acceptance (done)**: the detector demonstrably fires — construct two near-duplicate entries, confirm the mechanism flags/blocks the second, RED→GREEN. Bonus if it also catches one real existing near-dup pair in the current store.

**claimed:** this-session (2026-07-30) — ✅ CLOSED

## Resolution — done: write-time near-dup WARNING gate

**Approach (from 00's recommendation (i)):** the write seam IS accessible — `MemoryStore._addInner` already does an EXACT-dup check after `stripMetadata`. Extended it with a containment-based near-dup detector. Action = **WARN** (not block): the entry is still added, but the response flags the overlap + points to `memory replace` to consolidate. Warning-only is the low-risk choice — it meets the "flags" done-criterion without changing add semantics (no existing-test breakage, no blocked legit captures); a future escalation to block is a 1-line change.

**Delivered:**
1. **`src/store/near-dup.ts`** (pure) — `findNearDuplicate(content, existing[], threshold)` using containment of the new entry's filtered tokens in each existing entry (|new∩existing|/|new|). Tokenization: lowercase, split on non-word, drop <4-char + stopwords + pure-numbers, strip `[category]` prefix. Jaccard-over-full-text under-weights long entries sharing a core lesson but differing in prose; containment (new-in-existing) is the right direction for "is this re-stating an existing lesson?".
2. **`MemoryStore._addInner`** — after the exact-dup check, runs `findNearDuplicate`; on a hit, appends `⚠ near-duplicate of an existing entry (N% overlap): "<preview>…". Consider memory replace to consolidate.` to the success message. Configurable: `PI_MEMORY_NEAR_DUP_THRESHOLD` (default 0.6; 0 = disabled).
3. **`src/utils/env.ts`** — added `envFloat`.
4. **Tests** — `tests/store/near-dup.test.ts` (8 unit cases) + `tests/store/near-dup-integration.test.ts` (3 store-level: warns on near-dup, silent on distinct, disabled at threshold=0). TDD RED→GREEN.

**Validated against REAL data:** ran `findNearDuplicate` over the live failure store (52 entries) → flagged **5 genuine near-dup pairs** (SurrealDB ×2, mupdf, pdfimages ×2 — exactly the clusters 00 identified), **7/52 entries (~13%) involved, ZERO false positives**. The "bonus" criterion (catches a real existing near-dup pair) met.

**Done criterion met:** two near-duplicate entries → the second is flagged in the response (demonstrated), RED→GREEN.

**Honest boundary (deferred):** WARN doesn't auto-consolidate — the agent must act on the warning. If warnings get ignored, escalate to BLOCK (1-line). Also: the overflow paths (vaultOffload/fifoEvict) don't carry the warning (rare; the common normal-add path does).

**Verified:** unit 8/8, integration 3/3, full suite 855 pass (5 pre-existing local lock/timing flakes pass on CI), tsc clean.

**blocked by:** 00 (✅ closed)

**type:** task
