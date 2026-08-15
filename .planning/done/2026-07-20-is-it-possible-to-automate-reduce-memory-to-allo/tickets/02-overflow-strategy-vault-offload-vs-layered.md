type: grilling
status: closed (2026-07-20)
claimed: charting-session
blocked by: —

## Question

What overflow strategy should back the "never reject a durable write" guarantee — for **both** `add()` and `replace()` (replace currently has no overflow path at all)?

- **(A) Pure `vault-offload` default.** Deterministic FIFO evict-oldest → temp `.knowledge.jsonl` archive (recoverable via `zk_ingest`). Replace `auto-consolidate` as the default. Pro: always succeeds, no LLM, no flake. Con: evicts (to archive) rather than merges — info leaves *active* memory; recency is by file-position, not `lastReferenced`.
- **(B) Layered — `auto-consolidate` primary, `vault-offload` reliable fallback.** Keep the LLM merge as the first attempt (info-preserving); if it fails or doesn't free enough, fall through to `vault-offload` so the write **always** succeeds. Pro: preserves info when consolidation works, never hard-rejects. Con: still pays the LLM cost + flake-surface on the happy path; two code paths. *(This is the destination's stated intent — "deterministic, vault-offload > flaky LLM consolidate" — read as "vault-offload must be the guaranteed floor", not "consolidate is removed".)*

**Recommend (B) layered.** It matches the destination ("reliable" = the write always succeeds, via vault-offload floor) without discarding consolidation's info-preservation. (A) is simpler but silently ships evicted entries to a temp archive that must be manually `zk_ingest`'d — lossy-in-practice if nobody re-ingests.

Sub-decision that may graduate from this: should vault-offload write **directly** to the Obsidian vault (auto-`zk_ingest`) instead of temp-then-manual? (See map "Not yet specified".) Fold into this ticket unless it grows.

## Resolution

**Resolved (B) — layered.** `auto-consolidate` stays the primary (info-preserving LLM merge); `vault-offload` is the **guaranteed floor** — when consolidation fails or doesn't free enough, fall through to vault-offload so the write always succeeds (no hard `memoryFullError` on the happy path).

Build implications (hand-off):
- `_addInner`: after the consolidate retry, replace the `memoryFullError` fallthrough with a `vault-offload` call.
- `replace()`: add overflow handling that mirrors `_addInner`'s layered path (currently `replace` has none).

Open refinement (stays in map fog): whether vault-offload writes direct-to-vault vs temp-archive-then-manual-`zk_ingest`.
