# 05 — Routing-discriminator drift in the using-superpowers bootstrap

---
type: grilling
blocking:
status: open
---

## Question

The `using-superpowers` bootstrap (`src/superpowers.ts`, injected every session) carries the **pipeline-routing table** that references wayfind (DECIDE/SYNTHESIZE → Wayfind; DESIGN/PLAN/EXECUTE → Superpowers, per the repo's CLAUDE.md). If wayfind's skills/commands/stages change, superpowers' bootstrap **silently drifts** — it teaches an outdated routing rule. There's no contract test asserting the two stay aligned. How do we guard the routing-discriminator seam between the two instructional surfaces without coupling them in code (ADR-0005 forbids forking/merging)?

## What to build

A grilled decision on how to keep the routing-discriminator text in `using-superpowers` aligned with wayfind's actual stage surface. Candidate mechanisms:
- a **contract test** in superpowers asserting the stage→pipeline mapping matches a shared source-of-truth (where?);
- a **doc-link discipline** — the bootstrap defers to a single canonical routing doc rather than restating it;
- **accept** — the routing table is stable enough (DECIDE/SYNTHESIZE vs DESIGN/PLAN/EXECUTE) that drift risk is low.

This is the one seam that is *strictly* wayfind↔superpowers (not via core-task). Note superpowers contributes zero `__pi*` globals, so this is an **instructional/text drift** guard, not a runtime-contract one.

## Acceptance
- [ ] A decision: guard (which mechanism) or accept (documented rationale).
- [ ] If guarding: the shared source-of-truth or doc-link discipline is named, respecting ADR-0005 (no skill-body fork).
