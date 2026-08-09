# 05 — Routing-discriminator drift in the using-superpowers bootstrap

---
type: grilling
blocking:
status: closed
claimed: wayfinder-session
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
- [x] A decision: guard (which mechanism) or accept (documented rationale).
- [x] If guarding: the shared source-of-truth or doc-link discipline is named, respecting ADR-0005 (no skill-body fork).

## Resolution

**Guard via a repo-level source-analysis contract test** — `bun-apps/tests/routing-contract.test.ts` (run via `bun run test:routing`, wired into `regression gates` as the third repo-level guard beside `test:deps` + `test:seam`). Grilled sub-decision confirmed against the recommendation:

- **Guard, not accept.** Unlike ticket 04 (accepted: rare collision + git recovery net + incomplete guard coverage), ticket 05's drift has **no recovery net** (silent misrouting — the agent follows stale instructions) AND a **clean, complete, cheap guard**. Structurally identical to the guarded 02/03 seams.

**Two fact corrections to the ticket premise:**
1. **wayfind has no "stage" vocabulary** — its `CONTEXT.md:89` explicitly avoids it. The stage names (DECIDE/SYNTHESIZE/...) are superpowers' OWN framing, pinned by `bootstrap.test.ts`. The cross-package seam is the **3 wayfind skill names** the routing references: `grilling`, `wayfinder`, `to-spec`.
2. **superpowers-side drift is already guarded** (`bootstrap.test.ts` asserts the bootstrap contains the names). The unguarded gap was purely **wayfind-side**: wayfind renames/removes a referenced skill.

**Mechanism (mirrors ticket 03's no-orphans/no-dead):** canonical set `ROUTING_WAYFIND_SKILLS = [grilling, to-spec, wayfinder]`; **NO DEAD** (each exists in `wayfind/skills/`); **NO ORPHAN** (each still appears in `superpowers.ts` bootstrap source). ADR-0005 respected — it's a test, not a skill-body fork; source-of-truth is the guard's own array (same as `SEAM_KEYS`).

**Verified fails-loud:** simulated wayfind renaming the `grilling` skill dir -> `ROUTING DRIFT ... not found in pi-agent-ext-wayfind/skills/`; simulated superpowers dropping the reference -> `not found in superpowers.ts`. Baseline 2 pass; all 3 repo-level guards green (routing 2 / seam 3 / deps 5).
