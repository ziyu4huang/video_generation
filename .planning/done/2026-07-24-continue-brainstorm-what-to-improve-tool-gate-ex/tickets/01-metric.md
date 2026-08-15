---
type: grilling
status: closed
claimed: agent/grilling-2026-07-24
---

# 01 — Define the recall metric (what counts as a "miss")

## Question

The whole map hangs on this: **what is the headline metric for "keyword recall is good enough", and what exactly counts as a miss?** Every downstream ticket (instrumentation, workload, threshold, verdict) is undefined until this is settled. Grill to a decision.

Candidate metrics, with the trade-off each carries (recommendation last):

- **(a) Raw `miss_candidate` rate** — `isMissCandidate` (`tool-gate.ts:431`) over *every* non-triggering turn while a gate is dormant. **Reject**: near-100% on any diverse workload ("fix this typo" with `ltx` dormant counts). Measures nothing useful.
- **(b) `enable_tool` activation rate** — escapes per session (or per N turns). Every `enable_tool` call is a gate that *failed to auto-activate* and forced the escape hatch — a direct friction signal, trivially measurable from the existing `activate` telemetry (`tool-gate.ts:606/629/651`). Clean, but counts *cautious* escapes (model invokes it "just in case") as misses.
- **(c) "Confirmed miss"** — a `miss_candidate` turn (`:558`) followed (same session, by `ts`) by an `activate` whose `matchedGate` was dormant at that turn. Correlates the two event streams; filters both the (a) noise and the (b) cautious-escape false positives. Under-counts the *worst* case (model wanted a gated tool, didn't realize, told the user "unavailable" — no `activate` fires).
- **(d) Task-broke rate** — the user wanted a gated capability but the task failed/was degraded because the gate didn't fire and the model didn't recover. The gold standard, but needs human labeling of intent — infeasible at scale without a feedback loop we don't have.

A second axis inside this decision: **is a "miss" the gate's fault (keyword didn't fire) or can the *model's behavior* (does it proactively call `enable_tool`?) be in scope?** I.e., is a low escape-rate proof of good *matching*, or just of a *cautious model*?

**Recommended answer.** Primary metric = **(b) `enable_tool` activation rate** (escapes per session, reported with a per-gate breakdown) — it's the direct friction signal the extension exists to minimize, and it's measurable from telemetry that already fires with no new instrumentation. Refine with **(c) confirmed-miss** as a secondary lens (same report, correlated subset) to filter cautious escapes and point at *which* gates' keyword sets are weak. Defer (d) — if (b)+(c) leave the verdict ambiguous, a small human-labeled sample becomes a follow-up ticket. **Scope: gate's matching only** — the model's proactivity is a prompt-engineering concern (out of scope here; could graduate as a fix-menu item on a no-go).

## What a good resolution records

- The headline metric (and any secondary lens), stated precisely enough that [02] can compute it from JSONL.
- The unit/denominator (per session? per turn? per "session that touched a gated domain"?).
- The gate-vs-agent scope verdict (matching only, or model-behavior-included).

## Resolution (2026-07-24)

**Settled via grilling — all three sub-decisions confirmed.** The recall metric for the go/no-go is a two-lens bundle, conditional on relevance, attributing to the gate:

**Headline (descriptive friction): escape-rate.**
- Numerator: `activate` event count (every `enable_tool` call = a gate that failed to auto-activate).
- Denominator: **gated-domain sessions** — sessions where a gate fired OR `enable_tool` was called OR a relevant `miss_candidate` occurred (a gated tool plausibly mattered). NOT all sessions: pure-coding sessions never touching image/video would dilute the signal to near-zero.
- Reads: *"of sessions that needed a gated tool, X% forced the escape hatch."*

**Verdict driver (gate-causation): confirmed-miss rate.**
- A **confirmed miss** = a `miss_candidate` turn (`tool-gate.ts:558`) followed, same session by `ts`, by an `activate` whose `matchedGate` was dormant at that turn. Isolates GATE-CAUSED failures (keyword didn't fire; model recovered via escape).
- Reported as confirmed-misses per gated-domain session, **broken down per gate** → names which keyword sets are weak. The go/no-go bar (ticket 04) turns on THIS lens (zero confirmed-misses on common intents), not on raw escape-rate.

**Deferred: task-broke rate (option d)** — human-labeled; revisited only if headline + confirmed-miss leave the verdict ambiguous.

**Scope: gate-matching only.** The verdict judges the gate's KEYWORD recall. Model proactivity (does it call `enable_tool`?) is a separate lever — noted, graduates as a named fix-menu item on a no-go (see map Not-yet-specified). This reconciles escape-rate-as-headline with gate-only attribution: escape-rate is the friction that EXISTS (descriptive); confirmed-miss is what the gate is ACCOUNTABLE for (verdict).

**Rejected: raw `miss_candidate` rate** (`isMissCandidate`, `:431`) — fires on every non-triggering prompt with a dormant gate → near-100% noise on any diverse workload.

**Hand-off to [02]:** compute, per session (segmented by session boundary or a `ts`-gap heuristic), (a) escape count, (b) gated-domain-session flag, (c) confirmed-miss count + per-gate breakdown — all from the existing `turn`/`miss_candidate`/`activate` JSONL. No new instrumentation unless [02] finds a missing field; then it blocks and surfaces a sub-decision, never invents fields.
