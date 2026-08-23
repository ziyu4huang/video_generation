# 08 — hotness decay port

type: grilling
blocked by: 07 (hotness feeds the ranking composition)
status: CLOSED 2026-08-24 (D37–D40 + build + D14 A/B + reviewer pass)

## Resolution

OpenViking's `hotness_score = sigmoid(log1p(active_count)) * exp(-λ·age)`
(half-life 7d, ~60 lines) is ported — but the BLEND is a deliberate deviation
per D8: a **relative-score clamp** `final = score·(1+β(2h−1))`, β=0.1 — every
final stays within [0.9·score, 1.1·score]; "re-ranks but never dominates".

Design decisions (user-confirmed grilling, 2026-08-24; recorded as D37–D40):

- **Bound mechanics**: relative-score clamp β=0.1 (vs OpenViking's unbounded
  linear `(1−α)·sem+α·h`). A ±ε-neutral band (|h−0.5| ≤ 0.001) + sticky
  pre-fold tie-break keep neutral folds byte-identical (the existing
  flat/hier score pins never moved).
- **Usage feed**: the D12 `usage` table (RecallLedger). Writer = the
  `retrieveRecords` result boundary — served leaf cards, append-only
  `(stem, ts, kind='retrieve')`, opt-in `usageLog: true` at the production
  entry points (zk.retrieve host-fn, knowledge_query tool, CLI) — all four
  consumers inherit. Explicit zk_card/zk_fs read-access logging DEFERRED.
- **Aggregates at read**: live `GROUP BY stem` (count + `math::max(ts)`) per
  retrieval — amends D12's "replayed onto card after rebuild": usage stays the
  sole store, no card columns, always fresh; any read failure degrades to
  mtime-only hotness (still bounded).
- **Decay anchor**: `max(md mtime, last usage)`; half-life 7d (parity).
  Measured vault mtimes cluster ~1d (2026-08-24), so the usage feed is the
  discriminating signal today.
- **Fold points**: all three lanes — pure lexical (post-sort pre-slice),
  semantic (after the α-blend — never reshapes the pool), hier hydration
  (post-hydration on `hierScore`). Shared `rankWithHotness` helper.
- **Rebuild automation fold-back (ticket 05)**: `scheduleCardRebuild` —
  fingerprint-gated, in-flight coalesced, fire-and-forget, non-fatal;
  `indexRebuild: true` opt-in from every production write entry
  (ingestRecords + markSuperseded; zk_ingest tools/CLI, extract loop,
  shutdown lane). Env kill-switches `KCARD_INDEX_REBUILD=0` /
  `KCARD_USAGE_LOG=0`; client 180s timeout (a real 2351-card rebuild =
  61s measured; the 10s default aborts mid-swap).
- **Default-on gate (D8 + D25 composition)**: hit@5 ≥ 17/20 AND
  MRR ≥ max(0.688 flat, 0.725 no-hotness-hier). **MEASURED** 2026-08-24 on
  the real vault (throwaway ns, warmup = 1 battery round through the real
  writer): ON **17/20 @ MRR 0.742** (hit@1 13/20) vs OFF **17/20 @ MRR 0.725**
  (hit@1 12/20) — hit@5 tie at the ceiling + strict MRR gain → **default-on**,
  opt-out `KCARD_HOTNESS_DEFAULT=0` (mirrors D36's `KCARD_HIER_DEFAULT=0`).
  Only 2 per-query ranks moved (one 2→1, one 2→3) — the bounded re-rank.

## A/B receipts

`output/recall-audit/receipt-ticket08-hotness-off.json` (hier lane, shared
throwaway ns, 17/20 hit@5 MRR 0.725 — reproduces the 05 D36-switch numbers
exactly) · `receipt-ticket08-hotness-on.json` (same ns, warmup 1 round —
feedStems 88, 17/20 hit@5 MRR 0.742, hit@1 13/20).

Note: the first OFF run (before `--surreal-namespace` gating reached the
kcard arm's D36 lane) measured the FLAT fallback — 17/20 @ 0.688 — because
the real-ns index was an odd foreign 3-card shell (freshness gate degraded);
the gate's count check is exactly why hier ≠ stale answers. The real index
was re-rebuilt post-ticket via the production trigger (2351 rows, 61s) and
the deployment's hier lane + hotness arms are live again.

## Verification

- Tests: kcard **591/591** (+12 pure-function hotness, +4 retrieve-loop
  integration incl. the D40 env contract, +1 live ledger round trip + fold;
  eval-gate fixture extended with the `--hotness on --warmup 1` path),
  typecheck green; s2-agent 1048 pass + 3 skip; hermes 1553 pass.
- Independent reviewer: two reviewer subagent dispatches hung (delivery
  issue in the review session — both stopped after ~20–30 min without a
  report), so the adversarial pass was performed IN-SESSION (self-review
  against the D37–D40 claims + the reviewer prompts): survived — the sole
  finding was a trace-honesty cosmetic (lexical fall-through `hotnessUsed`
  required `!semantic`, understating a blend-failure fold) — fixed. The
  pre-dispatch reviewer-relevant findings already found during development
  (testMode hermeticity guard, the KCARD_* env kill-switch leak, the eval-gate
  spawn env scrub, the harness TDZ, the hydration-fixture trap, the
  `math::max` reserved word) are listed in the diff/commits.
- Harness: `recall-audit.mjs` gains `--hotness on|off` + `--warmup <n>`
  (explicit pins — an env flip never leaks into a baseline) and reuses the
  shared throwaway-ns index for apples-to-apples A/B runs; the pre-existing
  journal-arm import break (post-#1885 hermes `surreal-client.ts` rename)
  was fixed along the way (`@repo/s2-agent-core-interface` import).

## Fog (delta)

- Explicit zk_card/zk_fs read-access usage logging (the "accessed" half of
  OpenViking's content feed) — deferred, v1 feed = retrieval boundary only.
- The distill/converge + obsidian_distill raw-card writers are OUTSIDE the
  D40 trigger set (the trigger fires on ingestRecords + markSuperseded, the
  kcard card writers) — a distill-only write leaves the index stale until the
  next trigger-side write or a manual rebuild; the freshness gate degrades to
  flat meanwhile (bounded; record in the close-out if the reviewer finds a
  concrete covered writer that bypasses the trigger).
- Mid-swap failure mode: the D13 swap's multiple /sql steps can time out
  after the card copy lands but before the meta stamp + search-index DEFINEs
  land (observed once — the freshness gate's count+model check then sees
  "fresh" but the KNN/FTS lanes error → the hier lane still falls back to
  flat). Bounded; the long-timeout client narrows it; a post-swap index
  verification is the follow-up if it recurs.
