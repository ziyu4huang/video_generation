---
type: task
status: complete
---

# 02 — Content-aware freshness fingerprint (in-place-edit staleness)

## Question

How does the D36 freshness gate detect an in-place card edit (same file count, changed content) cheaply enough to run every session?

## What to build

Retrieval's freshness gate (currently md-count + embed-model) gains a content-aware aggregate over card files — e.g. per-file size+mtime digest or rolling content hash — so an in-place edit changes the fingerprint and the next rebuild trigger regenerates the index instead of serving the stale one. The flat fallback path remains the safety net: a fingerprint mismatch during a live session still falls back to flat, never blocks retrieval.

## Acceptance

- [x] Fixture-vault suite: edit-in-place, append, rename, delete each flip the fingerprint correctly; identical tree does not — `__tests__/fs-surface.test.ts` "freshness gate fingerprint leg (ticket 02)" (8 tests: identical serves; in-place/append/delete/rename flip; staleFingerprint flat; mtime-rewrite does NOT flip; unreadable folder → null); full package 615 pass / 0 fail, tsc clean
- [x] Real-vault check: an in-place edit + explicit rebuild produces a hier index whose card content matches the md (spot-check receipt) — measured 2026-08-24 on the live study-news vault (61 cards): in-place edit flips the gate verdict to flat; explicit rebuild (1381ms) re-stamps `index fp == live fp`; the edit marker is present in the card's indexed body; restore+rebuild returns to the original fingerprint (vault left as found)
- [x] Startup cost A/B receipt: gate evaluation stays negligible (it runs every session); no new breach entries in perf.jsonl — fingerprint compute measured **1ms** on the live vault; one-shot wall 6.72s/6.68s post-change vs the 6.2–7.3s session baseline (within noise; the gate runs per retrieval, not at startup); perf.jsonl untouched by this change (kcard lane, no hermes ops added)
- [x] D14: independent reviewer pass — APPROVE (inline, second consecutive silent reviewer subagent; disclosed in the PR). Key review finding FIXED in-change: the rebuild fingerprint previously excluded parse-skipped files while the gate hashed everything — the two could disagree forever; now both hash every READABLE .md via the shared `fingerprintOf` (parse-failed files ride the fingerprint, unreadable files are absent from both / gate-null → flat)

## Receipt — parse-dirty vault (measured 2026-08-25, closes the recorded gap)

Fixture: live study-news vault's `Zettelkasten/knowledge-graph` (61 md) copied to a temp vault; 2 files (`distill-avoid-gemma-4-12b-token-exhaustion.md`, `distill-pattern-post-regression-e2e-doctrine.md`) corrupted to unterminated-frontmatter garbage. Rebuild sequence ran on an isolated scratch Surreal DB (`context_db_receipt_tmp`); the live `context_db` asserted untouched before/after (script: `output/parse-dirty-receipt-20260825.ts`, gitignored scratch — sequence and numbers below are the durable record).

**Parse-skip reachability probe** (5 adversarial variants: unterminated frontmatter, tab/nesting garbage YAML, binary-ish garbage, empty file, lone `---`): **none parse-skip**. `parseFrontmatter` is lenient by design (unmatched lines are skipped, never thrown), so every readable-but-corrupt md still gets a row AND rides the fingerprint. The #1986 invariant (parse-failed files hashed into the fingerprint) is satisfied vacuously for this class — corrupted-but-readable content is simply an ordinary content change, not a row/fingerprint divergence risk.

**Fingerprint + rebuild sequence (61 cards, 2 corrupted):**

| step | result |
|---|---|
| clean fingerprint | `03f51319…c2553`, compute **1.24ms** median (runs 1.02/1.24/1.80ms) |
| corrupt 2 files | fingerprint flips to `672460cf…304c3` — **flip confirmed**; rows still 61, skipped `[]` |
| R1 clean initial build | real build, 61 inserted, **583ms** |
| R2 dirty tree | **exactly ONE forced rebuild** (fingerprint mismatch → shadow+swap), 61 inserted, **621ms**, stamps the dirty fp |
| R3 dirty unchanged | **skip** (fingerprint-gated no-op), 62ms |
| gate legs after R3 | present ✓, embed-model ✓, count 61=61 ✓, stamped fp == live fp ✓ → **verdict: hier serves** |

**Unreadable-file leg (dir named `*.md`, EISDIR):** the gate's `vaultFingerprint` correctly returns null (→ flat, never blocks retrieval), but `buildCardRows` **throws** — `getCardEmbeddings` pre-reads every file (semantic.ts:132) BEFORE the per-file read-skip guard, so the code-comment claim "unreadable → pushed to `skipped`, absent from both" (surreal-index.ts:262) is unreachable in practice. In production `scheduleCardRebuild` catches the throw → warns → index stays stale → gate serves flat: the graceful-degrade contract holds end-to-end, so no production change required by this ticket; recorded as a comment-vs-behavior mismatch + candidate follow-up (guard the embed pre-read, or fix the comment) rather than a design contradiction (D5 pattern).

Verdict: measurement **confirms** the design — fingerprint flip, exactly-one forced rebuild, re-stamp gate==index, hier lane serves after; fingerprint compute stays ~1ms at 61 cards.
