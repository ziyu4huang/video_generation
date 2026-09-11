---
effort: 2026-09-11-selfimprove-playbook
created: 2026-09-11
last: 2026-09-11
status: active
---

# Wayfinder map: 2026-09-11-selfimprove-playbook — the loop grows an operational playbook organ

## Destination

Adopt the field's self-improvement techniques (ACE evolving playbook,
ExpeL insight extraction — user directive: research the internet, apply to
the self-develop arc; research distilled in plans/arc-plan.md with sources)
as the loop's next organ: a curated, itemized, evidence-cited PLAYBOOK at
`.planning/playbook.md`; READ at arc open (arc-plan.ts --include-playbook,
receipt records playbook sha256); CURATED at arc close (Reflector/Curator
step in the self-reflect-next-goal SOP, itemized deltas only); SEEDED
ExpeL-style from the last ~10 arcs by a GLM-5.3 extraction dispatch with
every evidence link machine-verified; MEASURED via a paired with/without
arc-open A/B + per-arc cite/miss counters. Closes with receipts, one PR
through the devops chain, validated successor.

## Context (planner-verified 2026-09-11, this worktree @ main tip)

- Learnings log exists but is append-only prose, retrieval by
  description-match only (bun-apps/s2-agent-ext-devops/skills/learnings/
  SKILL.md; dual-write to .pi/agents/hard-problem.md) — gaps A+C confirmed.
- Close-out SOP has no reflector step (self-reflect-next-goal SKILL.md
  WRITE 0-7); next-goal file is strict-v2 validator-pinned — deltas go to
  the playbook, NOT new next-goal sections — gap B confirmed.
- Planner prompts are ad-hoc scratch (arc-plan.ts --prompt-file) — the
  injection point for read-at-open.
- Voyager-shaped promotion exists (.planning/knowledge/ staging →
  writing-skills); D7: workflow induction = pointers, not new machinery.
- Reviewer verdicts harvestable by name (arc-review.ts --name +
  reviewer-harvest --name arc-reviewer) — the A/B instrument.
- Evidence tier: receipts ≤256KB/file, ≤1MB/effort under
  .planning/<effort>/evidence/; maps never cite output/.
- Collision: audit-gate-fidelity (ultracode samples, devops local_ci src,
  ext package.json) + self-arc-24 (surface unknown). This effort touches
  only s2-agent-ext-subagent scripts/tests, devops skills markdown,
  .planning/ — GREEN.

## Tickets

- [ ] t01 scaffold: effort dir + branch (this commit)
- [ ] t02 schema + seeded playbook: .planning/playbook.md (ExpeL extraction
      dispatch → executor curation; every Evidence link machine-verified) +
      tests/playbook-schema.test.ts (subagent pkg)
- [ ] t03 read-at-open: arc-plan.ts --include-playbook (prepends playbook,
      receipt gains playbookIncluded + playbookSha256) + tests
- [ ] t04 close-out wiring: self-reflect-next-goal WRITE gains Reflect &
      Curate step; session-closeout-sop gains the twin lines; D5 boundary
      paragraph in the playbook header
- [ ] t05 A/B: identical directive dispatched twice (with/without playbook),
      mechanical checks (PB-id cites, sha256, 5-item repeated-mistake
      checklist) + arc-review.ts/harvest verdicts → evidence/ab-arc-open/
- [ ] t06 PR via devops chain (no package.json / local_ci src edits)
- [ ] t07 close-out: successor strict-v2 validated + repointed; status flip
      in landing PR; cross-effort links (learnings-hardening, self-arc-22);
      effort-audit exit 0

## Decisions so far

- D1 home = .planning/playbook.md (root file beside CONVENTIONS.md; NOT
  knowledge/ (transient), NOT a skill (description-match unreliable at arc
  open; SKILL.md drags the no-bash-skills seal)).
- D2 schema: itemized entries (PB-nn), hard caps (≤25 entries, ≤150 lines),
  supersede-in-place never delete, no entry without resolving Evidence.
- D3 curator = the closing session, folded into self-reflect-next-goal
  WRITE chain; dedicated reflector dispatch deferred to fog.
- D4 read-at-open mechanical: flag + playbookIncluded + playbookSha256 in
  plan-receipt.json (learning #2: receipts name the bytes).
- D5 boundary: learnings = append-only toolchain FACTS; playbook = curated
  operational STRATEGIES (supersede-able). Quirk → learnings; strategy →
  playbook.
- D6 measurement mechanical: PB-nn cite-counts in plans, repeated-mistake
  checklist, A/B with harvestable reviewer verdicts. Rejected: entry count,
  size, "was read" booleans.
- D7 scope fence: no model learning, no semantic retrieval (≤150 lines
  reads whole), AWM code-induction = pointers to .planning/knowledge/.

## Frontier

- t02: the seeded playbook is the artifact t03-t05 wire to and measure
  against.

## Fog of war

- self-arc-24's surface (other worktree) — rebase-order with the sibling
  before t03/t04 if it touches subagent scripts or the two SKILL.md files.
- Reviewer adjudication of plan quality is a weak instrument — mechanical
  cite-counts + mistake checklist are primary; reviewer corroborates.
- GLM-5.3 seed extraction may hallucinate evidence links — t02's mechanical
  resolution test drops them.
- Long-term adherence is a convention, not a gate (effort-audit red for
  "closed without curator pass" is a candidate follow-up).

## Cross-effort links

- Builds-on: 2026-09-06-learnings-hardening — generalizes the log into a
  curated strategy store (D5 boundary).
- Builds-on: 2026-09-10-self-arc-22-review-harvest — the A/B uses the
  harvestable reviewer.
