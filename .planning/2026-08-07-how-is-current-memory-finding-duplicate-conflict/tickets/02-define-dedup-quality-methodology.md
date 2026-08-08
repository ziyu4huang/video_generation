claimed: pi-agent (2026-08-07 work session)
type: grilling

## Question

How do we *measure* duplicate/conflict-detection quality so "improve it" is provable, not vibes? Decide the methodology: a labeled golden set of (exact-dup / near-dup / non-dup / conflict) entry pairs; the metrics per layer (precision / recall / F1 for exact, near-dup containment, topic-recurrence); the threshold sweep range for the 0.60 near-dup default; and the baseline that "better" must beat. This gates ticket 07 (build the corpus) and ultimately decides what (if anything) we change in the dedup algorithm.

## Resolution

**Methodology pinned: golden-set-based precision/recall/F1 per dedup layer + near-dup threshold sweep, against a hybrid (real-seed + synthetic) labeled corpus. Integrity (the addMemory double-persist gap from 01) is explicitly OUT of this methodology — it's a separate correctness fix.**

**Golden set (hybrid, seeded/reproducible):**
- Seeds = the 69 real entries in `~/.pi/agent/pi-hermes-memory/{MEMORY,USER,failures}.md`.
- Generate labeled pairs: exact-dup (identical content + metadata variants), near-dup (controlled perturbations: paraphrase, token-swap, substring, word-reorder — each with a known target-similarity band), non-dup (obviously-distinct entries), topic-recurrence groups (multiple notes sharing a topic-key, esp. tool-quirk backtick-ids).
- Seed the generator so 07's corpus is deterministic.

**Layers in scope:** exact (dedupNormalize), near-dup (findNearDuplicate containment), topic-recurrence (findTopicRecurrence). Conflict/merge-plan stays in its own correctness tests — NOT a P/R/F1 metric.

**Metrics:** per layer — precision, recall, F1. For near-dup: a threshold sweep across 0.3-0.9 (step 0.1) reporting P/R/F1 at each, identifying the F1-optimal threshold vs the current 0.60 default, and the precision/recall tradeoff (relevant since near-dup is warning-only).

**Baseline (what 'better' must beat):** the current implementation's P/R/F1 at default thresholds (exact: strict normalized match; near-dup @0.60; topic: deterministic key). 07 produces this baseline; any algorithm/threshold change later must improve it (or explicitly trade precision for recall with justification).

**Scope boundary:** detection quality only. The integrity gap (01: blind `addMemory` double-persist on the DB path) is a separate correctness fix — NOT measured here.

**Feeds 07:** this is the spec for the corpus+baseline builder. 07 emits the golden set + the current-impl P/R/F1 baseline + the threshold-sweep curve.

closed: 2026-08-07 (methodology: hybrid golden set, P/R/F1 per layer + near-dup sweep, detection-quality scope)
