---
type: grilling
blocking:
status: open
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
