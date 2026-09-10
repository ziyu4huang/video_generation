---
effort: 2026-09-10-kcard-quality-lift
created: 2026-09-10
last: 2026-09-10
status: done
---

# Wayfinder map: 2026-09-10-kcard-quality-lift — measured retrieval gaps and the embed-composition fix

## Destination

Raise the bench-measured retrieval quality toward the design thresholds
(tag recall@5 ≥ 0.90, MRR ≥ 0.70) — or produce the evidence-backed
amendment if the gap proves structural. Fix what the embed diagnosis
surfaces in the knowledge-card adapter/semantic layer, red-test-first.

## Context

Planner-led (arc-plan.ts, hard-problem/zai/glm-5.3, 361 s, 5/5 reads —
receipt `receipts/planner-plan-2026-09-10.{md,json}`). The planner
corrected the framing with file:line evidence (§5): the MRR lever is
`cardEmbedText` (semantic.ts:85-88), NOT the adapter summary — the
frontmatter summary was stripped before the embed slice and never reached
the vector; and the note bodies carried scaffolding (連結 link-lists,
record-meta tails, doubled `## 核心想法`). Executor additionally measured
the deep-body failure mode directly: questions whose answers live past the
800-char slice ranked 200–1700 while first-800-char questions ranked 1.

## Tickets

- [x] `tickets/01-embed-composition.md` — cardEmbedText: summary carried
      in, 連結/meta/H1 scaffolding stripped, window widened to
      EMBED_BODY_CHARS=2400 / EMBED_TOTAL_CHARS=3000 (bge-m3 8k window);
      exported for tests. 5 red-tests in card-embed-text.test.ts.
- [x] `tickets/02-adapter-header-dedup.md` — generic adapter strips the
      leading `## 核心想法` (renderCard re-emits it — measured doubled at
      generic-paper-gmsbench-gpu.md:16-17).
- [x] `tickets/03-gates-or-amend.md` — measured with fresh vectors: MRR
      0.153 → **0.162** (hit@3 0.158); tag recall unchanged 0.692. The
      residual is STRUCTURAL: pure-cosine question→note retrieval in a
      dense 2364-note LLM vault — competitors score 0.5+ vs the target's
      0.37 even with clean, deep embed text. Amendment recorded (D-amend
      below); deterministic gates assert the floor + bite check.

## Decisions

- D-amend (the T4 outcome): the design thresholds (MRR ≥ 0.70, tag
  recall ≥ 0.90) are NOT met by embed-composition alone — measured 0.162 /
  0.692 with clean, deep, summary-carrying embed text. The amendment:
  deterministic suite asserts the FLOOR (recall ≥ 0.5, bite-check collapse,
  zero violations) and the scorecard records the design thresholds as
  unmet targets. The path to 0.70 is the PRODUCTION blend (zk_ask's
  lexical FTS + semantic mix — the bench's raw-cosine lane deliberately
  does not model it) plus richer card content from richer conversions
  (file2md-side), both queued.
- D-ctx (1d judge): per-claim records now land in the scorecard
  (`perClaim`), judge context widened 4000→8000 chars; the single-page
  context limit is recorded (SPINE subset resolved 0 — full-paper context
  upgrade queued).
- D-offline: the sandbox embed refresh is BENCH_EMBED-gated — the offline
  tier embeds nothing (2364-note embed takes minutes; offline lanes are
  tag-lexical and never read vectors).

## Fog of war resolutions

- The semantic index embeds `cardEmbedText(raw, title, tags)` — full note
  body (windowed), title, frontmatter tags; the summary participated only
  after this arc's fix.
- ensureContextDb (SurrealDB) runs BEFORE getCardEmbeddings in the served
  rebuild — without a live SurrealDB the rebuild fails before embedding;
  the bench therefore calls getCardEmbeddings directly (file cache is the
  vector source the MRR lane reads).

## Cross-effort links

Builds-on: `2026-09-10-bench-kcards` (the measuring instrument),
`2026-09-09-file2md-kcard-pipeline` (the design). Supersedes nothing;
the successor after this arc carries the blend-measurement + content-richness
follow-ups.

## Shipped-as

PR (branch kcard-quality-lift): embed-composition fix + adapter header
dedup + bench embed-tier sandbox (awaited fresh vectors) + honest floor
gates; 5 new embed-text tests; knowledge-card 808/808, file2md 338/338.
