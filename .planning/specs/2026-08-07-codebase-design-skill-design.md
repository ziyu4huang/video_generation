# codebase-design Skill — Design Spec

> **Date:** 2026-08-07
> **Effort:** Roadmap Effort A (code-quality track)
> **Status:** Approved design → ready for implementation plan

## Goal

Add a shared deep-module design vocabulary (`codebase-design` skill) to the superpowers package, and wire it into the two skills where design language is most load-bearing (`brainstorming`, `writing-plans`), so agents design modules with precise, shared language and reach for the deletion test and the design-it-twice technique on core interface decisions.

## Background

This effort is the first of a code-quality-focused roadmap derived from studying Matt Pocock's upstream skills suite (`/Users/huangziyu/proj/pi-ext-matt-skills`). Comparative analysis found our design conversations use informal, unshared language ("units", "boundaries", "interfaces") scattered across brainstorming/writing-plans, with no portable rubric. Upstream's `codebase-design` is a model-invoked vocabulary layer that multiple skills speak.

Roadmap order: **A · codebase-design (this) → B · code-review rubric → C · improve-codebase-architecture (depends on A) → D · resolving-merge-conflicts → E · context-management track (ask-matt-style flow-map + phase-boundary tree + handoff; parked, sequenced after A–D).** This effort was chosen first because it is foundational — B's reviews and C's architecture survey are most powerful when measured against a shared design vocabulary. Effort E is parked and tracked for a later cycle — it is the context-management track (not a code-quality effort), and `handoff` there is a pi-adapted port that composes with pi's existing `memory` / `session_search` / `subagent_runs` persistence rather than duplicating it.

**Approach chosen:** "Skill + active vocab wiring" — create the skill AND patch the two consumer skills so the vocabulary is actually shared, not just available.

## Non-goals (out of scope)

- A `/design-it-twice` slash command or orchestration tool (deferred — may fold into Effort C).
- The `code-review` rubric, `improve-codebase-architecture`, `resolving-merge-conflicts` (separate roadmap efforts).
- Any change to wayfind's `domain-modeling` skill (already ahead of upstream — it has `_Source_:` anchors + a liveness check the upstream lacks).
- Adapting examples to Python (TS examples kept — clearest for interface concepts; deliberate).

## Design

### 1. Skill shape & classification

- **Placement:** `bun-apps/pi-agent-ext-superpowers/skills/codebase-design/`
- **Type:** pattern/reference skill (NOT discipline-enforcing) → lighter testing: recognition + application scenarios, not the rationalization-table/bulletproofing apparatus.
- **Invocation:** model-invoked (description-triggered, no `disable-model-invocation`) — same as upstream, so brainstorming/writing-plans can pull it in.
- **Files:** `SKILL.md` + `DEEPENING.md` + `DESIGN-IT-TWICE.md` (mirrors upstream structure).

### 2. Content (faithful adaptation of upstream)

**Glossary (use these terms exactly — the consistency is the whole point):**
- **Module** — anything with an interface + implementation (function/class/package/tier-spanning slice). Avoid: unit, component, service.
- **Interface** — everything a caller must know to use the module correctly: signature, invariants, ordering constraints, error modes, required config, performance characteristics. Avoid: API, signature (too narrow).
- **Implementation** — what's inside a module. Distinct from **Adapter**: a thing can be a small adapter with a large implementation (a Postgres repo) or a large adapter with a small implementation (an in-memory fake). Reach for "adapter" when the seam is the topic.
- **Depth** — leverage at the interface: the amount of behaviour a caller (or test) can exercise per unit of interface they must learn. Deep = large behaviour behind small interface; shallow = interface nearly as complex as implementation.
- **Seam** (Michael Feathers) — a place where you can alter behaviour without editing in that place; the *location* at which a module's interface lives. Where to put the seam is its own design decision. Avoid: boundary (DDD's bounded context overload).
- **Adapter** — a concrete thing that satisfies an interface at a seam; describes *role* (what slot it fills), not substance.
- **Leverage** — what callers get from depth: more capability per unit of interface learned. One implementation pays back across N call sites and M tests.
- **Locality** — what maintainers get from depth: change, bugs, knowledge, and verification concentrate in one place rather than spreading across callers.

**Deep vs shallow** — include the two ASCII diagrams (small interface + deep implementation vs large interface + thin implementation), and the three interface-shaping questions (reduce methods? simplify params? hide more complexity inside?).

**Principles (the payoff):**
1. Depth is a property of the interface, not the implementation (a deep module may be internally composed of small swappable parts that simply aren't part of the interface; internal seams vs the external seam).
2. **The deletion test** — imagine deleting the module; if complexity vanishes it was a pass-through, if it reappears across N callers it was earning its keep.
3. The interface is the test surface.
4. One adapter means a hypothetical seam; two adapters means a real one.

**Designing for testability** — keep the upstream TS code examples: accept dependencies don't create them (`processOrder(order, paymentGateway)` vs `new StripeGateway()`); return results don't produce side effects (`calculateDiscount(cart): Discount` vs `applyDiscount(cart): void`); small surface area.

**Relationships** (module↔interface↔depth↔seam↔adapter↔leverage/locality) and **rejected framings** (not Ousterhout's implementation-lines/interface-lines ratio — rewards padding; not the TS `interface` keyword — too narrow; not "boundary" — overloaded).

### 3. Reference docs

- **DEEPENING.md** — dependency categories → testing strategy:
  - *In-process* (pure, in-memory) — always deepenable, test through the new interface, no adapter.
  - *Local-substitutable* (PGLite for Postgres, in-memory FS) — deepenable if the stand-in exists; seam is internal.
  - *Remote but owned* (Ports & Adapters) — define a port at the seam; deep module owns logic, transport injected as adapter; in-memory adapter for tests, HTTP/gRPC/queue adapter for production.
  - *True external* (Stripe, Twilio) — take as an injected port; tests provide a mock adapter.
  - Seam discipline (one adapter = hypothetical, two = real; internal vs external seams).
  - **Replace, don't layer**: old unit tests on shallow modules become waste once tests exist at the deepened interface — delete them; the interface is the test surface; tests must survive internal refactors.
- **DESIGN-IT-TWICE.md** — frame the problem space (constraints + dependency category + rough sketch, show the user) → spawn 3+ parallel subagents each with a radically different constraint (minimize interface / maximize flexibility / optimize common caller / ports & adapters), each briefed with SKILL.md + CONTEXT.md vocabulary → each outputs interface + usage example + what's hidden + dependency strategy + trade-offs → present sequentially, compare on depth/locality/seam placement, give an opinionated recommendation (hybrid if warranted).

### 4. Wiring (the Approach-2 differentiator)

Both edits are **positive recipes** (the failure is informal design talk — a shaping problem, so prohibitions would backfire per `writing-skills` "Match the Form to the Failure"), reference codebase-design **by name** (no `@` force-load — token-careful), and are minimal — they sharpen existing intent rather than add bulk.

**`brainstorming/SKILL.md` — "Design for isolation and clarity":**

*Before (current):*
> - Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently
> - For each unit, you should be able to answer: what does it do, how do you use it, and what does it depend on?
> - Can someone understand a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.
> - Smaller, well-bounded units are also easier for you to work with [...]

*After:*
> - Break the system into modules that each have one clear purpose behind a small interface at a clean seam, testable through that interface
> - For each module apply the **deletion test**: imagine deleting it — if complexity vanishes it's a pass-through (fold it in), if it reappears across callers it earns its keep
> - Can someone use a module without reading its internals? Can you change the internals without breaking consumers? If not, the interface/seam needs work
> - When the design hinges on a core interface, run **design-it-twice** (`superpowers:codebase-design`): explore 2-3 radically different interfaces and pick on depth and leverage
> - **REQUIRED SUB-SKILL:** Use `superpowers:codebase-design` for the shared vocabulary (module/interface/seam/depth/leverage/locality) whenever a design involves module boundaries
> - Smaller, well-bounded modules are also easier for you to work with [...] (keep the existing file-size point)

**`writing-plans/SKILL.md` — "File Structure":**

*Before (current):*
> - Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
> - You reason best about code you can hold in context at once [...]
> - Files that change together should live together. Split by responsibility, not by technical layer.
> - In existing codebases, follow established patterns [...]

*After:*
> - Design modules with small interfaces at clean seams (`superpowers:codebase-design`). Each file one clear responsibility; apply the **deletion test** to any module — if removing it makes complexity vanish, fold it back in
> - You reason best about code you can hold in context at once [...]
> - Files that change together should live together (**locality**) — split by responsibility, not by technical layer
> - When a file grows large or a boundary is contested, reach for **design-it-twice** (`superpowers:codebase-design`) to compare interface options
> - In existing codebases, follow established patterns [...]

### 5. Testing approach (writing-skills Iron Law — most of the effort)

No skill or edit ships without RED→GREEN→REFACTOR via subagents.

**For the new skill (pattern skill → recognition + application tests):**
- **RED:** dispatch subagents a design task (e.g. "design the interface for a module that batches and retries a flaky remote API") *without* the skill. Document the baseline verbatim: informal "unit/boundary" language, no deletion test, no design-it-twice, over- or under-introducing seams.
- **GREEN:** with the skill loaded, re-run the same scenarios; confirm vocabulary is used correctly, the deletion test is reached for, design-it-twice is invoked on the core interface decision.
- **REFACTOR:** plug loopholes (e.g. name-dropping vocabulary without applying it; invoking design-it-twice on a trivial interface).

**For the two wiring edits (behavior-shaping → wording micro-tests):**
- Per `writing-skills`: 5+ reps per variant, one fresh-context sample each, include a no-guidance control. The edit must measurably increase codebase-design invocation in the design phase vs the control.

## File inventory

| Path | Action |
|---|---|
| `bun-apps/pi-agent-ext-superpowers/skills/codebase-design/SKILL.md` | create (adapt) |
| `bun-apps/pi-agent-ext-superpowers/skills/codebase-design/DEEPENING.md` | create (adapt) |
| `bun-apps/pi-agent-ext-superpowers/skills/codebase-design/DESIGN-IT-TWICE.md` | create (adapt) |
| `bun-apps/pi-agent-ext-superpowers/skills/brainstorming/SKILL.md` | edit (wiring) |
| `bun-apps/pi-agent-ext-superpowers/skills/writing-plans/SKILL.md` | edit (wiring) |

## Success criteria

- A fresh agent, given a module-interface design task, uses the deep-module vocabulary correctly, reaches for the deletion test, and invokes design-it-twice on non-trivial interface decisions.
- `brainstorming` and `writing-plans` reference `superpowers:codebase-design` by name and the vocabulary is used during their respective design phases.
- All three new files and both edits pass the writing-skills RED→GREEN→REFACTOR gate.

## Post-validation pivot (2026-08-07)

**Outcome differs from the placement/wiring above.** During Task 8 verification, `bun test` revealed that `pi-agent-ext-superpowers` is a **strict byte-identical port of `obra/superpowers`** (exactly 14 skills; ADR-0004/0005/0006 forbid any local edit to skill bodies or any non-upstream addition). Adding `codebase-design` there and wiring `brainstorming`/`writing-plans` violated that contract and failed deliberate regression-guard tests.

**Actual resolution:**
- `codebase-design` is re-homed to **`pi-agent-ext-wayfind`** (`skills/codebase-design/`), the "Pi-native port of Matt Pocock's suite," which adapts freely (no byte-identity contract). Validated content preserved (RED 0/3 → GREEN 3/3); the condensed-vs-full edit kept; `description:` rewritten to start `Use when` (wayfind frontmatter rule); per-skill provenance footer removed (wayfind centralizes attribution in README).
- The `brainstorming`/`writing-plans` wiring (Approach 2) was **dropped** — superpowers forbids editing pinned bodies. Instead `codebase-design` is **globally auto-invocable by its description**, capturing the core "shared vocabulary" value (the model reaches for it whenever a design involves module boundaries). The explicit `REQUIRED SUB-SKILL` nudge was the casualty.

**Strategic implication for the roadmap:** superpowers is off-limits for the *entire* code-quality track. **B** (code-review rubric — would edit ported `requesting-code-review`/`code-reviewer.md`), **C** (improve-codebase-architecture — new skill), and **D** (resolving-merge-conflicts — new skill) all need non-superpowers homes (wayfind or new dedicated packages). Re-anchor the roadmap accordingly before starting B/C/D.
