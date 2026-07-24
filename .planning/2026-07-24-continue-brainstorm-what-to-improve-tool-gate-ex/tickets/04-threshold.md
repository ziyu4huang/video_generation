---
type: grilling
status: closed
claimed: agent/grilling-2026-07-24
blocked by: [01-metric]
---

# 04 — Set the go/no-go threshold

## Question

**What value of [01]'s metric separates "recall is good enough" (go — ship as-is) from "recall needs work" (no-go — graduate the fix-menu)?** This is the actual verdict bar; settling it *before* seeing the data keeps the decision honest (no moving the goalposts to fit the measurement).

The threshold is inherently a tolerance call — how much escape-hatch friction is the user willing to accept in exchange for the ~8,500 tok/req saving? There is no externally-correct number; it's a preference. Grill it.

Candidate framings (assume [01] lands on `enable_tool` activation rate as primary):

- **Escape-rate ceilings** — e.g. "≤1 `enable_tool` call per session on average" / "≤X% of sessions that *wanted* a gated tool needed the escape hatch". Needs the denominator [01] fixes.
- **Confirmed-miss ceiling** — "0 confirmed misses (miss_candidate → activate) on common-intent turns over the window" — a stricter, matching-quality bar. Attractive but the under-counting caveat (worst case = no `activate`) means a zero here isn't proof of perfection.
- **Comparative** — "no worse than the pre-#778 baseline" (but we have no pre-#778 measurement, so this is unfalsifiable as stated — only viable if we capture a baseline now and re-measure after a future change).

**Recommended answer.** A **two-line bar**: (1) primary — escape rate ≤ a small absolute ceiling per session (the user picks the number that matches their tolerance; my cold-start nudge: ≤1 escape/session on average, with escapes clustered on rare/intent-ambiguous prompts being acceptable); (2) secondary — zero confirmed-misses on the *common* intents (the `MUST_FIRE` corpus as the "common" reference). Go requires **both**; failing either = no-go. Crucially: agree the numbers *before* [05] runs, so the verdict is data-applied, not data-rationalized.

## What a good resolution records

- The threshold value(s) for the primary (+ secondary) metric, in the units [01] defined.
- Whether the bar is absolute, comparative, or both.
- A short statement of the *tolerance rationale* (why this much friction is acceptable for the saving) — so a future session can tell if the user's tolerance has shifted.

## Resolution (2026-07-24)

**Settled via grilling (1 question) + a code fact-check.** Bar set cold, before any data — keeps the verdict honest.

**The go/no-go bar (single, gate-causation):**
- **GO** iff **zero confirmed-misses on common intents** over the window.
- **NO-GO** iff **≥1 confirmed-miss on a common intent** → that keyword set has a real, fixable gap; graduate the fix-menu.

**"Common intents"** = the gate's design-intent corpus — the `MUST_FIRE` probe set (`qa/probes.ts`) + the intent classes the gate was built to catch. A confirmed-miss on any = the gate's contract is broken on an intent it claims to handle.

**Escape-rate: descriptive, no ceiling.** Reported for context; carries no threshold. 01 separated model-caution out of scope, so penalizing high escape use would conflate a cautious model's good behavior with gate failure.

**Fact-check (enables the bar):** the telemetry carries enough to classify — `miss_candidate` events log `promptHead` (first 80 chars) + `dormantGates` (`tool-gate.ts:558`); the correlated `activate` logs `matchedGate` + `intent` (`:651`). So a confirmed-miss (miss_candidate → activate, `matchedGate` non-null) is classifiable from `matchedGate` (domain) + `promptHead` (phrasing). **Caveat:** `promptHead` is truncated to 80 chars — usually enough for short common-intent phrasings; [02] must FLAG (not guess) any confirmed-miss it can't classify from the truncated head.

**Rationale for zero (not a small N):** over a ~2-week window, even one common-intent confirmed-miss is a concrete, fixable keyword gap — a tolerance would absorb exactly the signal this map exists to surface. Strictness is cheap because the fix (broaden a keyword/verb set) is cheap. Revisit only if the window is too thin for zero to be meaningful.

**Absolute, not comparative:** no pre-#778 baseline was ever measured; the bar stands on its own. A comparative bar needs a baseline captured now + a re-measure after a future change — out of scope for THIS verdict.

**Hand-off to [02]:** classify each confirmed-miss (miss_candidate→activate, `matchedGate`≠null) as common-intent via `matchedGate` ∈ MUST_FIRE-covered domains ∧ `promptHead` pattern; flag (don't guess) unclassifiable cases. Excludes no-match escapes (`matchedGate` null, `activated` []) — those aren't confirmed-misses.
