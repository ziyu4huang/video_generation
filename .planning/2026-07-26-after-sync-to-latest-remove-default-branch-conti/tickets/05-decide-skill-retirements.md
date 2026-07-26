---
type: grilling
status: closed
claimed: superpowers-simplify-2026-07-26
resolved: 2026-07-26
---

# 05 — Decide which skills to retire / merge

## Question

Beyond `verification-before-completion` (already excluded by default), which
skills are redundant or unused enough to add to `DEFAULT_SKILL_EXCLUDE` — and
should any be *merged* rather than just excluded?

Mechanism (ticket 01): retiring = add the skill dir-name to `DEFAULT_SKILL_EXCLUDE`
in `src/superpowers.ts`; reversible via `PI_SUPERPOWERS_SKILL_EXCLUDE` env. So
this is low-risk and toggleable — the decision is *capability/value*, not safety.

The decisions to grill:
1. **Retirement bar** — what counts as "genuinely redundant or provably unused"?
   (e.g. capability fully covered by another skill; never surfaces in real
   sessions; overlaps >80% with a heavier skill.)
2. **Candidates** — walk the 14 currently-loaded skills and classify each:
   keep / exclude / merge-into-another. Note research found *none* orphaned by
   reference graph, so "unused" must be argued on value, not graph degree.
3. **Merge vs exclude** — for overlapping pairs (e.g. the review pair
   `requesting-code-review` + `receiving-code-review`; the plan pair
   `writing-plans` + `executing-plans`), is merging the content into one skill
   better than excluding one?

Independent of ticket 04 (compression is about *content weight*, this is about
*which skills exist*). Both can proceed in parallel.

## Resolution (2026-07-26)

**Bar (Q1):** retire only if the skill's capability **and** methodology are
*fully* subsumed by another loaded skill **or** pi's native behavior — zero
loss, matching the destination's "preserve everything relied on."

**Candidate review (Q2):** walked all 13 loaded skills; read the 3 overlap
candidates in full (`dispatching-parallel-agents`, `executing-plans`,
`using-git-worktrees`).
- `dispatching-parallel-agents` — teaches *reactive* parallel investigation
  (one agent per independent problem domain) + agent-prompt-crafting + a
  decision flowchart. Distinct from pi's `workflow` tool (capability, no
  methodology) and from SDD (plan-driven). **Not subsumed.**
- `executing-plans` — the *no-subagent* fallback; its own description defers to
  SDD when subagents exist (pi has subagents), so it's rarely primary in pi —
  the one borderline. But it carries a distinct cross-session + human-checkpoint
  cadence absent from SDD. **Kept** (borderline, but no-loss bar → keep).
- `using-git-worktrees` — leverages native worktree tooling but adds the
  *when-to-isolate* + fallback methodology pi doesn't encode. **Not subsumed.**
- The other 10 are clearly distinct capabilities with no pi-native methodology.

**Decision: retire NOTHING.** Under the strict bar every loaded skill earns its
place; the set is complementary, not redundant — consistent with the ticket-04
pilot finding that the extension is comprehensive, not bloated.
`verification-before-completion` stays the only default-excluded skill
(pre-existing, unchanged). No change to `DEFAULT_SKILL_EXCLUDE`.
