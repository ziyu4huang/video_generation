# Simplify superpowers ↔ wayfind pipeline routing

## Problem Statement

The two parallel pipelines — **superpowers** (design/plan/execute) and **wayfind** (decide/interview) — are kept from colliding by `piBoundaryOverrides()`: ~2,300 chars of prose enumerating **four** runtime rules, injected into every bootstrap. Two concrete pains (confirmed by the user as equal-weight):

1. **Heavy glue.** Rules 1, 3, 4 are the *same idea* stated three times — "redirect a pinned skill's upstream artifact path into `.planning/<effort>/`." The redirect mechanics are already built (`PI_PLANNING_EFFORT` env + `sdd-workspace` script + `start-server.sh` + the `.gitignore` line); the rules only re-document them verbosely.

2. **Mis-routing.** Rule 2's discriminator — *"can I write a plan right now from what's already settled?"* — is a **judgment call**. The brainstorming↔grilling overlap (both "explore before build") makes it fuzzy, so the agent sometimes enters the wrong pipeline.

## Solution

Collapse the four rules into **two**: one canonical-home invariant, and one stage-table discriminator that keys routing on **filesystem state** (which artifacts exist) rather than a judgment. This shrinks the glue ~60% and turns 4 of 5 routing decisions into unambiguous disk checks.

### The new `piBoundaryOverrides()` body (literal target)

```text
## Pipeline routing (this repo)

Superpowers and Wayfind are two parallel pipelines sharing the `.planning/<effort>/` layout.
Two rules:

**1. One canonical home.** Every artifact lives under `.planning/<effort>/` — specs,
plans, the SDD workspace (briefs/reports/reviews/progress.md), and brainstorm mockups.
The pinned skills' upstream paths (docs/superpowers/, .superpowers/) are overridden at
runtime by PI_PLANNING_EFFORT (sdd-workspace + start-server.sh honor it). Never write to
the upstream paths when an effort is active.

**2. Pick the pipeline by stage — check what's on disk first.**

| Stage      | Trigger (check disk)                          | Pipeline                                |
|------------|-----------------------------------------------|-----------------------------------------|
| DECIDE     | no spec yet, decisions open / route foggy     | Wayfind — grilling (or wayfinder)       |
| SYNTHESIZE | a grill just settled; spec needed             | Wayfind — to-spec (synthesize only)     |
| DESIGN     | requirement clear, zero open decisions        | Superpowers — brainstorming             |
| PLAN       | spec exists, no plan                          | Superpowers — writing-plans             |
| EXECUTE    | plan exists                                   | Superpowers — executing-plans / SDD     |

Four of five stages are a filesystem check. Only DECIDE-vs-DESIGN needs judgment
("are decisions open?"). When in doubt, DECIDE first — it's cheap insurance against
building on a foggy route.
```

### Why it kills both pains

- **Glue shrinks:** three verbose redirect recipes → one invariant. The "four runtime rules" preamble becomes "two rules." Body drops from ~2,300 → ~950 chars (≈60% shorter).
- **Mis-routing shrinks:** the discriminator becomes a stage lookup. Four of five stages are unambiguous filesystem checks. The brainstorming↔to-spec overlap is **partitioned** — SYNTHESIZE (synthesize-only, after a grill settled the decisions) vs DESIGN (design from a clear requirement) — so the two skills no longer compete for the same stage. This is the "C-light" refinement folded in for free.

## Implementation Decisions

1. **Single edit site.** Rewrite the return string of `piBoundaryOverrides()` in `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` (currently lines ~245-256). No other source changes — the redirect mechanics (`PI_PLANNING_EFFORT`, `sdd-workspace`, `start-server.sh`, `.gitignore`) are already correct and are merely pointed at by the shorter rule.
2. **Stage table as discriminator.** Five stages (DECIDE / SYNTHESIZE / DESIGN / PLAN / EXECUTE), each mapped to exactly one pipeline + skill. The table is the agent's routing lookup.
3. **SYNTHESIZE/DESIGN partition.** `to-spec` owns synthesize-after-grill; `brainstorming` owns design-from-clear-requirement. This removes the one genuine overlap.
4. **No skill edits.** ADR-0004 fidelity pin on the 14 `SKILL.md` files is untouched — the change is prose injected by the bootstrap, not a skill-body change.
5. **No new skills, no router skill** (Approach B, rejected), **no full stage-ownership partition** (Approach C, rejected — we take only the SYNTHESIZE/DESIGN split as a natural consequence), **no package merge** (ADR-0005).

## Testing Decisions

- **Structural test (the gate).** Extend `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts` to assert the bootstrap output **contains** the new markers — the five stage labels (`DECIDE`, `SYNTHESIZE`, `DESIGN`, `PLAN`, `EXECUTE`), "One canonical home", and "check what's on disk" — and **does not contain** the retired *bolded rule headers* (the exact strings `**1. Artifact-home override.**`, `**2. Entry-path routing.**`, `**3. SDD workspace override.**`, `**4. Visual-companion convergence.**`, and the preamble phrase `Four runtime rules`). Note: topic *words* like "SDD workspace" legitimately reappear in the new rule 1 body — assert absence of the full retired *header* strings, not bare topic words.
- **Weight check.** Assert the new `piBoundaryOverrides()` return value is **≤ 1,200 chars** (target ≈ 950). This guards against the prose re-bloating and is deterministic (no baseline-recording needed).
- **Fidelity.** `skills-fidelity.test.ts` stays green — pinned files unchanged.
- **Behavioral A/B.** Deferred (expensive, mirrors the Phase-3 harness). Recorded as an optional follow-up, not a gate.

## Out of Scope

- Merging the two packages (ADR-0005 — parallel coexistence stands).
- Editing any pinned `SKILL.md` (ADR-0004).
- Adding a router skill (Approach B).
- A full single-ownership partition beyond the SYNTHESIZE/DESIGN split (Approach C).
- The prompt-weight workstream (Phase 1/2/3 — separate effort; this is orthogonal and composes with it).

## Further Notes

- Builds on the existing wins: Phase 1/2 token cuts (~377 tok/req), the boundary docs (dep-tree PRD §9, ADR-0005), and the `.planning/`-convergence already shipped (sdd-workspace, start-server.sh, gitignore).
- Composes with the orthogonal `PI_SUPERPOWERS_SKILL_EXCLUDE` knob (Phase 3, Task 5): that unregisters skills; this rewrites the routing prose. They don't interact.
- The single remaining judgment (DECIDE-vs-DESIGN: "are decisions open?") is irreducible — but it's now the *only* judgment, explicitly called out, with a tiebreaker ("when in doubt, DECIDE first").
