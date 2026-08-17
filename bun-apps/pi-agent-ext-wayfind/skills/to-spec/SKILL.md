---
name: to-spec
description: Use when turning what's already on the table into `.planning/<effort>/spec.md` — synthesis only, no interview; artifact contract + chain wiring. Invocation via `/wayfind spec`.
disable-model-invocation: true
---

# To Spec

Synthesize what's already on the table into a spec (PRD). Do **not** interview the user — just synthesize. Use the project's domain glossary (`CONTEXT.md`) vocabulary throughout, and respect any ADRs in the area you're touching.

Interview and idea-development methodology: see the superpowers **brainstorming** and **writing-plans** skills.

## Chain wiring

- **Precedes:** `grill-me-with-docs` / wayfinder map collapse — decisions must be settled first (else brainstorm or grill before synthesizing).
- **Follows:** `/wayfind tickets` → `/wayfind seed` → executing-plans / subagent-driven-development.

## Entry criteria

Start only when the source map is frozen: the map exists and its `## Not yet
specified` is empty (or every remaining item is explicitly deferred with an
owner). If questions remain open, grill (grill-me / grill-me-with-docs)
before synthesizing — do not interview during to-spec.

## Artifact contract: `.planning/<effort>/spec.md`

Required sections:

1. **Problem Statement** — the problem, from the user's perspective.
2. **Solution** — the solution, from the user's perspective.
3. **User Stories** — a long numbered list (`As an <actor>, I want <feature>, so that <benefit>`), covering all aspects of the feature.
4. **Implementation Decisions** — modules to build/modify, interfaces, technical clarifications, architectural decisions, schema changes, API contracts, interactions. No file paths or code snippets (they go stale); exception: prototype snippets encoding a decision more precisely than prose (state machine, reducer, schema, type shape), noted as such.
5. **Testing Decisions** — what makes a good test (external behavior, not implementation details), testing at the highest existing seam where possible, which modules get tested, prior art in the codebase.
6. **Out of Scope** — what is explicitly out of scope.
7. **Further Notes** — anything else worth recording.

Write the file to `.planning/<effort>/spec.md` (never `docs/specs/` or anywhere else — superpowers' `brainstorming` converges on the same `.planning/` home; its no-effort specs land in the flat `.planning/specs/`, a separate entry path). Tell the user the path.
