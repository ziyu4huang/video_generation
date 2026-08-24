---
type: task
blocking: 03
status: closed
---

# 02 — Directory L1 overview + L0 abstract generation (bottom-up, sampled)

## Question
Does one LLM call per directory (inputs = child abstracts + child-dir L0s, bottom-up, deterministically sampled above a bound) produce L1 overviews whose extracted L0 abstracts make directory-level relevance judgments work?

## What to build
`resource-ingest` gains the semantic tier pass: after L2 rows land, directories are processed leaves→root; each gets an L1 `.overview.md` sidecar (one `chatJson` call, `overview_generation` prompt shape, JSON fast path) and an L0 `.abstract.md` extracted from L1's leading paragraph (clamp enforced, never a second call). Sidecars carry OKF-style frontmatter (`generated_by`, `freshness` counters) and are visible in Obsidian; sidecar bodies become level-0/1 `resource` rows with their own embeddings. Directories above the measured sampling bound get a deterministic sample of children in the prompt (bound + token budget measured and recorded here). Re-ingest refreshes a directory only when its `pending_child_changes` counter crosses the threshold (upstream freshness policy shape).

## What to measure in this ticket (Fog-of-war items)
- Sampling bound + prompt token budget on the flat 839-child USB4 pages/ dir; decide single-sampled-L1 vs TOC-derived chapter segmentation, record the decision + numbers in the Resolution
- file2md resumability unaffected by sidecars (manifest is page-scoped) — verify by re-running file2md smart over the sidecar'd tree

## Acceptance

- [x] A 3-level fixture tree (mocked LLM) produces correct bottom-up order, sidecars with valid frontmatter, level 0/1 rows, and incremented freshness counters on child edit
- [x] USB4 tree: every directory has L0+L1 rows; the root abstract is a faithful ≤2-sentence description (recorded sample in receipt); LLM call count = directory count (not file count)
- [x] Child-edit → only the ancestor chain refreshes (fingerprint + counter evidence)
- [x] Hermetic unit tests for L0-extraction clamp, sampling determinism, sidecar frontmatter; one live-LLM smoke on a small real dir (on-demand)
- [x] Canonical `bun run test` green; reviewer pass (or disclosed inline fallback)

## Resolution

Implemented in `bun-apps/s2-agent-ext-knowledge-card/src/resource-tiers.ts` (new) +
`src/resource-index.ts` (sidecar → level-0/1 rows, fingerprint gains sidecar hashes,
schema salt `v2-l0l1`) + `s2-agent cli resource-ingest` (tier pass default-on,
`--no-tiers`, dry-run tier plan). PR #2023.

**Design deltas vs the ticket text** (all recorded reasons):
- The L1 call is markdown-out, not JSON — `chatJson` with a lenient identity parse;
  `reasoning_effort:"none"` is REQUIRED even for markdown output (measured
  2026-08-25: without it, local reasoning models leak chain-of-thought into
  `content` and the L0 extraction then indexes reasoning junk as the abstract).
- Freshness adaptation: upstream counts semantic-change events off a queue; batch
  re-ingest derives the same pending count by diffing per-child content hashes
  (files: content; child dirs: the child's L0 text) against state kept in
  `.resource-semantic/tier-state.json`, with the correctness gate mirrored in
  the sidecar's `children_fingerprint` (losing the state file degrades to one
  full refresh, never corruption).
- Canonical-L0 rule: the parent hashes the child's `.abstract.md` body (clamped),
  NOT the unclamped overview extraction — hashing the unclamped text made every
  long-abstract dir phantom-refresh on re-ingest (caught live, regression test).

**Fog-of-war measurements (recorded):**
- **Sampling decision: single sampled L1 — no TOC-derived chapter segmentation.**
  USB4 `pages/` = 839 direct entries → deterministic 32-sample (evenly spanned,
  first..last included), prompt = 5,781 chars ≈ 1.5k tokens — far under any
  budget; bound `TIER_SAMPLE_LIMIT = 32` (upstream default), ratio 0.10.
  Chapter segmentation stays unnecessary at this scale; revisit only if a
  future eval shows sampled L1 misranks chapter-level queries (ticket 04's lane).
- **file2md resumability: SAFE.** `file2md --extract smart` re-run over the
  sidecar'd tree resumed all 839 pages in 0.57s (per-page `status:done` gate at
  `s2-agent-ext-file2md/src/pipeline.ts:286`; the manifest enumerates pages,
  never directory files). Sidecars survived untouched. Bonus receipt: the
  follow-up `resource-ingest` was fully idempotent (0 LLM calls, 844 cached).

**Live receipts (USB4 840-file tree, production index):**
- 844 rows = 840 L2 + 2 L0 + 2 L1 (`SELECT level, count()` → 2/2/840); LLM
  calls = 2 = directory count; embedded 4 (sidecars only) / cached 840.
- Root L0: "This directory contains the official USB4 Specification 2.0,
  published in November 2025 by the USB Promoter Group." (1 faithful sentence).
- Small-dir live smoke (3 dirs): 3 calls = 3 dirs; leaf edit → exactly the
  ancestor chain refreshes (3 dirs), sibling untouched; unchanged re-run →
  0 LLM calls + DB fingerprint SKIP.
- Hermetic: 17 new tests (bottom-up order, frontmatter round-trip, level-0/1
  row shape, chain-only refresh, wide-dir pending accumulation 0.025→pending /
  0.125→refresh, planOnly purity, L0 clamp, sampling determinism, prompt shape,
  phantom-refresh regression). kcard canonical `bun run test` 654/0.
