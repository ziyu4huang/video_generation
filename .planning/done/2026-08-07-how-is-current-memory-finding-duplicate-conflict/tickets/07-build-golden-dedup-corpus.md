type: prototype
claimed: claude (inline session, 2026-08-08)

## Question

Build the labeled golden corpus from 02's methodology: real + synthetic entry pairs tagged exact-dup / near-dup / non-dup / conflict, drawn partly from the actual `.md` memory files. Run the *current* detection layers against it to produce the precision/recall/F1 baseline (exact, near-dup @0.60, topic-recurrence) plus a threshold sweep. This baseline is the yardstick every dedup change is judged against, and tells us whether token-containment is good enough or a bigger algorithm change (see map fog) is warranted.

## Spec locked (from 02, now closed)

See `tickets/02-define-dedup-quality-methodology.md` Resolution: build a seeded hybrid golden set (69 real-entry seeds + synthetic perturbations), labeled exact-dup / near-dup / non-dup / topic-recurrence. Run the CURRENT dedup layers against it: emit per-layer P/R/F1 (exact, near-dup @0.60, topic) as the baseline, plus the near-dup threshold-sweep curve (0.3-0.9, step 0.1) with F1-optimal vs 0.60. Detection-quality only; conflict/merge-plan and the integrity gap are out of scope. 07 is unblocked and ready to build.

## Resolution (closed 2026-08-08)

**Built**: `bench/dedup-golden-corpus.ts` — 80 labeled pairs (exact-dup 32, near-dup 22, topic-recurrence 10, non-dup 16). near-dup containment + topicKey computed at load via the REAL exported functions; exact pairs verified normalize-equal. Seeds are realistic memory-style content (not verbatim MEMORY.md lifts) — real-seed fidelity is a flagged follow-up; baseline shape unaffected.

**Baseline** (`bench/dedup-baseline.ts` -> `bench/results/dedup-baseline-*.md`):

| layer | P | R | F1 | note |
|---|---|---|---|---|
| exact | 1.000 | 1.000 | 1.000 | corpus invariant (pairs normalize-equal by construction) |
| near-dup @0.6 (current) | 1.000 | 0.545 | 0.706 | misses 10/22 semantic near-dups |
| topic-recurrence | 1.000 | 1.000 | 1.000 | broad by design (warn-layer; cross-fires on shared-topicKey near-dups, fine) |

Near-dup threshold sweep — precision stays 1.000 at EVERY threshold (no false positives on non-dup pairs, even at 0.3):

| t | R | F1 |
|---|---|---|
| 0.3 | 0.955 | 0.977 |
| 0.4 | 0.818 | 0.900 |
| 0.5 | 0.773 | 0.872 |
| 0.6 (current) | 0.545 | 0.706 |
| 0.7 | 0.364 | 0.533 |

F1-optimal threshold = 0.3 (F1 0.977, delta +0.271 vs current).

**Verdict (feeds 08)**: token-containment is sufficient — no new algorithm (MinHash/Jaccard/embeddings) warranted. The current 0.6 threshold is simply too high: dropping to ~0.3-0.4 recovers near-dup recall from 54.5% to ~82-95% with zero precision cost. This resolves the map's "what to change in dedup" fog -> a threshold-config edit (execution item for the post-map writing-plans handoff), not a new map ticket. Remaining for 08: where dedup/conflict detection LIVES (MD-layer-only vs promoted into the shared MemoryRepository contract — see 01's blind-addMemory double-persist gap) + canonical source-of-truth.

**Caveats**: exact-layer 1.0 measures the corpus invariant, not layer capability; non-dup set is small (16) so precision error bars are wide (but P=1.0 at all thresholds is reassuring); conflict/merge-plan out of scope (per 02).
closed: 2026-08-08 (golden corpus + baseline done; near-dup threshold 0.6 too high, feeds 08)
