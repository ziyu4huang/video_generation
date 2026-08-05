---
type: grilling
status: closed
claimed: agent (2026-08-05)
closed: 2026-08-05 (grilled this session)
blocked by: 01
---

# 02 — Taxonomy & purpose: what belongs in the global failure store?

## Question

What is the failure-memory target *for*, and what belongs in it? The audit ([01](01-audit-the-failure-store.md)) shows the store is dominated by **operational tool-quirks about devops/git tooling** (`await_pr_merge`, `gh pr`) — not lessons about the memory extension or the project itself. Decide the scope rule:

- Should recurring **operational tool-quirks** (about arbitrary tools the agent happens to use) live in the *global* failure store at all, or in a separate per-tool / per-domain surface?
- Is the failure store for **curated, cross-session lessons** only — or does it also carry transient operational state?
- What's the inclusion test an entry must pass to earn a slot in the 40K budget?

This is the upstream decision: it determines what [dedup](04-dedup-identity-and-merge-rule.md) canonicalizes *among* and what [decay](05-decay-aging-and-supersede-policy.md) retires.

## Context

- The 45-tag mix (19 tool-quirk / 13 convention / 12 insight / 1 failure) suggests the "failure" target has become a catch-all for anything tagged — the `tool-quirk` category especially.
- `REJECTED.md` is silent on taxonomy; the categories (`failure`, `correction`, `insight`, `convention`, `preference`, `tool-quirk`) are defined in the memory policy but their *target* routing isn't questioned.

## Recommendation seed

Lean toward: the global failure store keeps **curated, durable, cross-session lessons**; recurring operational tool-quirks either (a) get a bounded quota, or (b) move to a per-tool quirks file so they don't crowd lessons. Put the actual cut to the user.

## Resolution — ANSWERED (2026-08-05)

**Decision — the failure-memory target's taxonomy & purpose:**

1. **Purpose / first-capture home (write path unchanged).** The failure target stays the inclusive first-capture home for *any* categorized lesson (`failure | correction | insight | convention | preference | tool-quirk`). No write-time classification, no upfront exclusion. (Affirms the existing `constants.ts:111` design; rejects "static narrow at write time" as too error-prone.)

2. **Recurrence = procedural signal → graduate to a skill.** A lesson re-recorded / needed **≥ 2×** is, by that recurrence, *procedural* (a HOW) and graduates out of the failure target into the skill system. This activates the already-existing `constants.ts:145` rule ("same procedure 2+ times → skill candidate"). The `await_pr_merge ×7` are the canonical example: they should be the `land-pr` skill, not seven failure entries.

3. **Post-graduation state: one canonical FACT + skill cross-reference.** On graduation, the failure entries collapse to **one deduped standalone fact** (e.g. *"await_pr_merge merges directly when green since #1030; historical hazards X/Y"*), cross-referenced to the skill that holds the *procedure*. Rich procedural content lives only in the skill. Fact ≠ procedure → no duplication; the failure entry stays self-describing and recallable via `memory_search(target=failure)` without budget bloat.

**Why over the alternatives:** "static narrow at write time" requires fact-vs-procedure classification on every write (hard, error-prone); "no taxonomy change" leaves procedural HOWs permanently occupying the lesson budget — the exact bloat the audit found. This rule uses the *empirical* recurrence signal (already endorsed in `constants.ts:145`) to drive promotion, keeping the write path simple.

**NOT decided here (downstream):**
- The **recurrence identity key** (what makes two captures "the same topic") → [04 — Dedup identity & merge rule](04-dedup-identity-and-merge-rule.md).
- The **graduation trigger mechanism** (auto-promote on 2nd capture? manual via consolidation? on-write reject?) → folds into [04](04-dedup-identity-and-merge-rule.md) (its dedup resolution now also defines the promotion path).
- How `memory_search` surfaces the cross-referenced skill → mechanism (05/06 or build).

**Map implications:** [04](04-dedup-identity-and-merge-rule.md) scope expands (dedup now *produces* canonical-fact + skill-promotion); [05](05-decay-aging-and-supersede-policy.md)/[06](06-migration-and-cutover-plan.md) inherit the "one canonical fact + skill xref" target shape; the map's "dedup identity key" fog graduates cleanly into 04.
