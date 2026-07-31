---
type: grilling
blocked by: []
status: closed
claimed: wayfind-session (2026-07-31)
resolved: 2026-07-31 (DO — reviewRan field + ⚠ summary + top-level escalation)
---

# 06 — Decide: Watchdog zero-layer-ran → hard sentinel

**Source**: 02#2 · axis `robustness` · **Impact 4 / Effort 1 / score 20** (rank 2)

## Question

Decide do/defer/skip + sentinel shape for the "watchdog requested but zero layers
ran → false sense of reviewed" risk.

## Resolution (grilled 2026-07-31, branch behind:6, 0 touched subagent/workflow src)

**Decision: DO** — a **double sentinel** (machine field + prominent ⚠ summary)
**escalated to the subagent-tool top level**, not buried in `details.watchdog`.

**Facts found (not asked)**: `WatchdogResult = { ran, editGated, l1, l2, summary,
elapsedMs }` (`watchdog/types.ts`); surfaced only via `details.watchdog`
(`subagent-tool.ts:79`), a **soft gate that never auto-fails**. `summarize()`
(`watchdog.ts`) emits a bland "L1+L2 degraded" substring when a layer didn't run.
Two distinct "didn't review" cases exist — **edit-gated / skipped** (`ran:false`,
correct skips: no diff, or recursion guard) vs **zero-layer-ran** (`ran:true` but
both `l1.ran`/`l2.ran` false — the false-sense case). Anything checking only the
top-level result or `details.watchdog.ran` misses the latter entirely.

### Grilled fork

- **Loudness** (Q1) → **double + escalate to top level** over (double-within-watchdog
  / field-only / defer). The ticket's whole point is visibility, and `details.watchdog`
  is a buried sub-object — so the sentinel must reach the subagent result's top level.

### Spec (handoff)

1. **`reviewRan` field** — add `reviewRan: boolean` to `WatchdogResult`
   (`watchdog/types.ts`); set in `runWatchdog`'s return.
   Definition: **at least one REQUESTED layer actually ran** —
   `reviewRan = (opts.l1 && l1.ran) || (opts.l2 && l2.ran)` (handles the
   partial-request case: `watchdog:true` = L1-only, so reviewRan tracks L1 alone).
2. **Prominent summary** — in `summarize()`, when `ran:true` but `reviewRan` is
   false, emit `⚠ watchdog: REVIEW DID NOT RUN (requested, 0 layers executed) —
   <degraded reasons>` instead of the bland "degraded".
3. **Top-level escalation** — in `subagent-tool.ts`, when
   `watchdogResult.ran && !watchdogResult.reviewRan`, BOTH:
   - append a top-level ⚠ line to the result text (e.g.
     `⚠ review requested but no watchdog layer ran — see details.watchdog`), AND
   - set a top-level boolean on `details` (e.g. `reviewRequestedButSkipped: true`)
     so callers gating on the top-level result see it without drilling into
     `details.watchdog`.
4. **Scope guard** — the sentinel fires ONLY in the zero-layer-ran case
   (`ran:true && !reviewRan`); edit-gated / skipped (`ran:false`) already correctly
   signal "didn't review" and MUST NOT trigger the sentinel.

### Acceptance criteria (for the implementer)

- (a) Zero-layer-ran (L1 no `typescript-language-server` + L2 no `review`/`big`
  tier) → `reviewRan:false`, ⚠ summary, top-level ⚠ line + boolean.
- (b) Edit-gated (no diff) → `ran:false`, **no** sentinel (correct skip).
- (c) Normal (L1 runs) → `reviewRan:true`, no sentinel.
- (d) Partial: only L1 requested → reviewRan tracks L1; L1 misses → sentinel fires.

**No new ticket graduates.** Implementation is handoff (wayfinder is planning).
