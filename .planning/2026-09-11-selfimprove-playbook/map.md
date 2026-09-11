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

- [x] t01 scaffold: effort dir + branch (this commit)
- [x] t02 schema + seeded playbook: .planning/playbook.md (ExpeL extraction
      dispatch → executor curation; every Evidence link machine-verified) +
      tests/playbook-schema.test.ts (subagent pkg)
- [x] t03 read-at-open: arc-plan.ts --include-playbook (prepends playbook,
      receipt gains playbookIncluded + playbookSha256) + tests
- [x] t04 close-out wiring: self-reflect-next-goal WRITE gains Reflect &
      Curate step; session-closeout-sop gains the twin lines; D5 boundary
      paragraph in the playbook header
- [x] t05 A/B: identical directive dispatched twice (with/without playbook),
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

## A/B results + findings (2026-09-11, evidence under evidence/ab-arc-open/)

- Identical directive (gemma-column fill from the LATEST residuals),
  dispatched twice: with playbook (sha bc8d9b3613c5 recorded in receipt) vs
  without. Both glm-5.3, 11 turns each — controlled.
- **Mechanical checks**: with-plan cites 17 distinct PB-nn ids (22 total
  mentions; 16/20 if the worktree status-table row is excluded — counting
  rule now stated); without-plan cites 0; playbookSha256 recorded only on
  the with receipt. Checklist: stale-main/label-trust HIT on both plans;
  handrolled-git: no hits in either (earlier draft's claim corrected).
  Disclosed confound: the with-leg was INSTRUCTED to cite PB ids
  (arc-plan.ts prepend), so cite-count partly measures compliance — the
  adjudication's application-level judgment carries the interpretation.
- **Adjudication verdict: PLAYBOOK-DISADVANTAGE** (arc-review.ts +
  reviewer-harvest, receipt committed at evidence/ab-arc-open/adjudication/). Mechanism: the
  playbook demonstrably improved open/close ceremony (PB-01/02/03/04/05/16/
  20 — dedicated worktree, status-flip discipline, effort-audit gate,
  push-before-successor, cross-links) — but the with-planner CITED PB-12 to
  justify REUSING drive-case's `/v1/models` contention oracle while missing
  PB-12's own second clause (suspect the ruler): the list is a catalog, not
  residency (`lms ps` showed nothing loaded), so its precondition was
  unsatisfiable by construction. The no-playbook planner spent the same
  budget on the measurement and found the catalog-vs-residency flaw itself.
- **Curated delta #1 applied**: PB-12's strategy now includes the concrete
  oracle distinction (catalog ≠ residency; `lms ps` for residency) with the
  adjudication as evidence — the curator loop's first real delta, and the
  playbook improved from its own first A/B (the ACE mechanism working).
- Recorded for the successor: reviewer verdicts are a weak instrument for
  plan quality (the drive-case learnings said so; this A/B is the receipt);
  a same-turn-batch-aware C2 order check keyed to the EXPECTED skill's
  position is still open from the A/B arc.

## Shipped-as (2026-09-11)

- PR <impl>: the playbook organ (playbook.md + schema test + arc-plan.ts
  --include-playbook with receipt sha256 + SOP wiring) + the A/B experiment
  + curated delta #1 (PB-12 oracle clause).
- This PR flips the map done per CONVENTIONS.

## Reviewer round (2026-09-11, independent GLM-5.3 pass)

REQUEST-CHANGES, 1 blocker: the adjudication verdict receipt existed only in
gitignored scratch while the map cited it — fixed (committed at evidence/
ab-arc-open/adjudication/ incl. review-receipt.json + a pre-delta playbook
snapshot so the A/B receipt's bc8d9b36 sha is re-derivable). Should-fix
adopted: mechanical-check numbers corrected to the reproducible rule
(17/22 distinct/total, or 16/20 excluding the status-table row;
handrolled-git claim withdrawn); "853 pass" → 852 pass + 1 pre-existing
skip; cite-count instruction-confound disclosed. Verdict on substance:
"the organ is real, tested, and the negative A/B result is honest."
Receipt: output/reviewer- (see output/spwf-playbook/pr-review/review.md).
