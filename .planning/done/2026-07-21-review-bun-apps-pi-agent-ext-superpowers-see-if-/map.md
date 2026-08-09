---
effort: 2026-07-21-review-bun-apps-pi-agent-ext-superpowers-see-if-
created: 2026-07-21
last: 2026-08-09
status: complete
---

# Map — Review & refine the superpowers ↔ wayfind boundary

## Destination

A prioritized, **decided** set of recommendations about where the
`pi-agent-ext-superpowers` plan/execute skills end and the
`pi-agent-ext-wayfind` decide skills begin — plus light cleanup decisions.
No code changes in scope: the destination is *decisions*, not deliverables
(wayfinder default "Plan, don't do"; execution graduates into separate efforts).

## Notes

- **Domain**: Pi extension architecture + the Superpowers skill methodology.
  Two sibling packages: `pi-agent-ext-superpowers` (port of `obra/superpowers` —
  brainstorming/writing-plans/executing-plans/etc.) and `pi-agent-ext-wayfind`
  (port of Matt Pocock's decision-chain suite — grilling/wayfinder/to-spec/
  to-tickets/domain-modeling). Upstream origin checked out locally at
  `../superpowers/` (git remote `obra/superpowers`).
- **Skills every session should consult**: `grilling`, `domain-modeling`,
  `wayfinder` (meta — this *is* a wayfinder map). Read the overlapping skill
  bodies before resolving a boundary ticket: `to-spec`, `to-tickets` (wayfind),
  `brainstorming`, `writing-plans` (superpowers).
- **Standing preferences**: zh-TW conversation, English artifacts. Plan-don't-do
  (destination = decisions). Refer to tickets by name, never bare number.
- **Key fact**: the wayfind README already declares the intended model —
  wayfind = "the decompose-and-decide phase of the Superpowers methodology."
  The collision points below are where that intent is *imperfectly realized*;
  resolving them refines the boundary, it doesn't reinvent it.

## Decisions so far

- [Upstream decide→plan transition](tickets/01-research-upstream-decide-to-plan.md) — upstream has no separate decide-phase; `brainstorming` IS decide+spec+decompose, and `to-spec`/`to-tickets`/`grilling`/`wayfinder` are all this-repo additions. Headline: `unified-planning-dir.patch` exists to align the homes but is **not currently applied** — so the two families write to different artifact homes and `to-spec`'s "same spec.md" claim is false right now.
- [Spec authorship boundary](tickets/02-spec-authorship-boundary.md) — **parallel coexistence**: to-spec and brainstorming are two independent pipelines (decide-done vs standalone), not a shared flow. Converge homes via the stalled patch; entry-path mutual-exclusion trigger stated only in this-repo-owned files (to-spec description + bootstrap), not in upstream-verbatim brainstorming.
- [Decomposition boundary](tickets/03-decomposition-boundary.md) — **parallel coexistence, cannot merge**: to-tickets↔core-task coordinator and writing-plans↔subagent-driven-development are coupled decomposition+execution stacks (output shape is dictated by executor contract). No structural move (to-tickets stays in wayfind, coupled to coordinator). Homes + trigger inherit 02. Closes the "structural skill moves" fog; fully unblocks the patch-convergence execution.
- [Big-effort planning scope](tickets/04-big-effort-planning-scope.md) — **discriminator is fog (plan-writability), not size**: "can I write a plan now?" Yes→writing-plans (any size, huge via sub-project decomp); No→wayfinder (huge) or grilling (small). No murky middle, no merge. Completes the main axis — entry-path rule now sharp end-to-end (04→02→03).
- [package.json manifest entry](tickets/05-packagejson-manifest-entry.md) — **correct the path** to `./extensions/superpowers.ts` (was a dead `./extensions/index.ts`); keeps the manifest honest and matches the convention; static registration stays the live load path.
- [Sync source duality](tickets/06-sync-source-duality.md) — **keep plugin cache as canonical sync source, document the relationship**; `../superpowers/` git checkout is reference-only (not a sync source); fidelity tests catch drift regardless.

## Not yet specified

<!-- fog toward the destination; graduates as the frontier advances -->

- **Encoding the resolved boundary.** Once the three collision tickets close,
  the answer probably wants to outlive the conversation: an ADR (hard-to-reverse
  skill ownership split), a `CONTEXT.md` glossary entry pinning
  "decide-phase vs plan-phase", and/or edits to the overlapping skills'
  `description` frontmatter so triggers stop colliding. Can't ticket the *form*
  until the *substance* is decided — graduates from the collision tickets.
  _(Now fully specifiable: all three collision points (02/03/04) decided. The
  substance — fog-discriminator entry rule + parallel-coexistence pipelines +
  this-repo-owned trigger wording — is settled. Encoding graduates into the
  downstream execution effort: ADR + CONTEXT.md glossary + description edits.)_
- **Patch-convergence execution.** Ticket 02 decided to apply
  `unified-planning-dir.patch` (converge brainstorming/writing-plans to
  `.planning/<effort>/`) + edit to-spec's description + add a bootstrap
  deferral note. This is concrete, specifiable execution — but it's past the
  map's decision destination, so it graduates as a **downstream task**, not a
  map ticket. **Now fully unblocked** — both 02 and 03 decided convergence;
  ready to bundle as a single downstream execution effort.
- **Activation-model divergence.** superpowers injects a `using-superpowers`
  bootstrap into context every session; wayfind skills are invocation-only
  (`disable-model-invocation: true`, driven by `/wayfind` commands). Two
  different activation models coexist. May or may not be a real problem —
  revisit once the boundary is drawn; if the agent gets confused about *which*
  family is active, this graduates into a ticket.
- **Structural skill moves.** Resolving the decomposition collision (to-tickets
  vs writing-plans) may conclude that a skill should physically move between
  packages (e.g. to-tickets into superpowers). That's a refactor decision that
  graduates from the decomposition ticket, not a standalone question yet.
  _(RESOLVED by 03: firm NO — to-tickets stays in wayfind, coupled to its
  executor. Cleared from fog.)_

## Out of scope

<!-- ruled beyond the destination; closed, never graduates -->

- **Porting upstream hooks / scripts / docs / CI / plugin-formats** (`.claude-plugin`,
  `.codex-plugin`, `.cursor-plugin`, `hooks/`, `.github/`). The user scoped
  upstream ideas to *boundary-relevant* research only — a broad "what else from
  obra/superpowers is worth porting" sweep is a separate effort.
- **Actual code changes / implementation.** The destination is a decision list;
  doing the work is a downstream effort (or graduates from this map).
