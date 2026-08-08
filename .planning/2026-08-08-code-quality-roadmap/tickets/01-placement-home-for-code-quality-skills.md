---
type: grilling
blocking:
status: closed
---

# Placement: home package for B/C/D code-quality skills

## Question

Where do deliverables B (code-review guidelines), C (improve-codebase-architecture), and D (resolving-merge-conflicts) live?

Options on the table:
- **Wayfind** — consolidate all code-quality skills into `pi-agent-ext-wayfind/skills/` (alongside codebase-design). Pro: one home, no new package, matches A. Con: wayfind's scope broadens into a general "adaptable skill grab-bag".
- **New `pi-agent-ext-design` package** — a dedicated package for engineering/design/code-quality skills. Pro: clean separation of concerns, discoverable boundary. Con: new-package overhead (manifest, registration, schema-cost canary wiring).
- **Hybrid** — e.g. B (a process skill) in wayfind, C/D (design skills) in a new design package.

Constraint: superpowers is locked (ADR-0004) — not an option for any of B/C/D.

This is the GATING decision: until placement is fixed, B cannot be scoped/built (brainstorming + writing-plans need to know the home package).

## Resolution

**B/C/D all go in `pi-agent-ext-wayfind/skills/`**, alongside codebase-design (matches A; no new package).

Rationale: consistency with the shipped A (codebase-design already lives there); zero new-package overhead (no manifest/registration/schema-cost canary wiring); wayfind is the designated adaptable pi-skill home. Accepted trade-off: wayfind holds both DECIDE-process skills (grilling/to-spec/to-tickets) and code-quality skills — acceptable since all are agent-craft skills and the boundary is conceptual, not technical.

Per-deliverable auto-invocability + content sourcing → ticket 02.
