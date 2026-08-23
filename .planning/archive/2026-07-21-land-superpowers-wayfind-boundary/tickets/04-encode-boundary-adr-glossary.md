# 04 — Encode the boundary (ADR + CONTEXT.md glossary)  [optional]

---
type: task
blocking: 01, 02
status: closed
optional: true
---

## Question

Make the resolved superpowers ↔ wayfind boundary outlive the conversation:
record it as an ADR (hard-to-reverse skill-ownership + verbatim-body split) and
pin the vocabulary in a `CONTEXT.md` glossary. Optional — the decisions are
already captured in the review map and the study-news SOP; this just hardens
them in-repo.

## What to build

1. **ADR** — `bun-apps/pi-agent-ext-superpowers/docs/adr/0005-parallel-coexistence-boundary.md`
   (next number after the existing 0004). Records:
   - **Parallel coexistence**: two non-connecting pipelines — wayfind
     (decide-phase: grilling/wayfinder/to-spec/to-tickets → core-task
     coordinator) vs superpowers (plan/execute: brainstorming/writing-plans →
     subagent-driven-development). Not a shared flow.
   - **Discriminator**: fog / plan-writability ("can I write a plan now?").
   - **Decomposition coupling**: output shape dictated by executor contract;
     cannot merge without unifying execution models.
   - **The verbatim-body / injection-layer principle** (cross-references
     ADR-0004): upstream skill bodies stay byte-identical; local divergence
     (path convergence, trigger routing) is expressed in the
     this-repo-owned bootstrap, never by patching verbatim bodies. Cite the
     `4fc140be` revert as the cautionary precedent.

2. **Glossary** — the `CONTEXT.md` that owns the methodology vocabulary
   (`pi-agent-ext-wayfind/CONTEXT.md`): pin **decide-phase** (wayfind:
     resolve fog → decisions/spec/tickets) vs **plan/execute-phase**
   (superpowers: spec → decompose → TDD deliver). Note the `.planning/<effort>/`
   unified layout and that the bootstrap carries the routing + path-override.

## Acceptance

- [ ] ADR-0005 written with the four points above, cross-referencing ADR-0004
- [ ] `CONTEXT.md` glossary entries for decide-phase / plan-phase, linking the
      ADR
- [ ] Both reference the bootstrap (ticket 01) as the runtime expression of the
      boundary, and the descriptions (ticket 02) as the discovery-layer
      expression
