---
type: task
status: closed
---

# 02 — Make wayfind's own docs honest about the plan coordinator

## Question

How should pi-agent-ext-wayfind's own documentation describe the plan coordinator and the `/goal`-driven execution loop, so it stops propagating aspirational-as-live language that the study-news note (and any future re-summarizer) copies?

## What to build

Make the extension's doc sources truthful about CURRENT reality:
- `skills/wayfinder/SKILL.md` "Work through the map" step 3 — the claim that setting `/goal` "activates plan-mode coordination (…progress publishing via `__piPlan*` seams)" is aspirational; `__piPlan*` is never published. Align it with `skills/to-tickets/SKILL.md`'s already-honest "### Set the session objective" (manual: prompt `/goal`, seed `todo`s, call `goal_complete`; cite ADR-0003).
- `README.md` §coordination — mark the plan coordinator as designed-not-built; reframe the "reverse seam (`/wayfind sync` reads `__piPlanPhases`)" as a graceful no-op until a coordinator exists (cross-ref sibling effort `2026-07-19-build-plan-coordinator`).
- `CONTEXT.md` seam entries — same correction: coordinator unbuilt; forward bridge (`seedPlan`) works; feedback bridge (`syncChainState`) is a no-op today.

Describe CURRENT truth. If `2026-07-19-build-plan-coordinator` later SUCCEEDS, these docs get a follow-up update to "built" then — not a blocker here.

## Acceptance

- [x] wayfinder/SKILL.md step 3 no longer claims `__piPlan*` seam publishing happens at runtime.
- [x] README §coordination + CONTEXT.md mark the coordinator as designed-not-built (ADR-0003) and describe the manual protocol as the working path.
- [x] wayfinder/SKILL.md and to-tickets/SKILL.md agree on how the execution loop is described (no internal contradiction).
- [x] No claim contradicts grep-verified behavior (zero publishers of `__piPlan*`).

## Resolution

Made wayfind's own docs honest about the plan coordinator per ADR-0003 (3 files, 7 blocks):

- **`skills/wayfinder/SKILL.md`** "Work through the map" step 3 — dropped the aspirational "progress publishing via `__piPlan*` seams" claim; now prompts the user to `/goal` (TUI-only, no agent setter per ADR-0003), describes the manual protocol (seed `todo` / advance / `goal_complete`), cites ADR-0003. Now aligned with `skills/to-tickets/SKILL.md`'s already-honest "### Set the session objective".
- **`README.md`** — coordination table row + continuous-chain row + `/wayfind sync` command row + the "## Coordination with the plan coordinator" section all mark the coordinator designed-not-built and the reverse seam a graceful no-op today; added a Status blockquote citing ADR-0003 + the manual protocol.
- **`CONTEXT.md`** — Coordination seam + grill→plan handoff entries now note the coordinator is unbuilt + manual protocol.

Verified: `bun test` **143 pass / 0 fail**; `bun run build` (tsc) **exit 0**; grep confirms **zero** aspirational remnants ("progress publishing via" / "activates plan-mode" / "the plan coordinator reads it…yields" / "which the plan coordinator then drives") across the 3 files; **8** ADR-0003 / "designed-not-built" mentions now present. `tests/skills.test.ts` is frontmatter-only — no frontmatter touched, unaffected.
