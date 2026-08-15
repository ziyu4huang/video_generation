---
type: grilling
blocking: 01
status: closed
---

# Next deliverable: which (B/C/D) + scope + content source

## Question

Once placement (ticket 01) is decided, which deliverable ships next, and what is its content provenance?

- **Sequencing:** B (code-review guidelines) is the natural next — first pending, and A (codebase-design) laid the foundation. C/D build on established design review.
- **Sourcing options:**
  - Matt-Pocock-derived: adapt his `requesting-code-review` + `code-reviewer.md`.
  - Pi-original: author fresh, tailored to this repo's pi-agent-ext + MLX + SDD conventions.
  - Hybrid: his structure, this repo's specifics.
- **Auto-invocability:** description-based (codebase-design pattern) vs invocation-only.

Blocked by 01 — cannot scope the skill without knowing its home package.

## Resolution

**Next deliverable: B (code-review guidelines).** Sourcing: study Matt-Pocock's code-review skills then adapt to this repo (same provenance as A). Placement: `pi-agent-ext-wayfind/skills/` (per ticket 01). Auto-invocability: description-based (per A's proven pattern), finalized during brainstorm.

DECIDE stage clear (tickets 01 + 02 resolved) → transition to Superpowers: brainstorm → spec → plan → SDD for B. C/D sourcing + sequencing re-enter this map as new tickets when B ships.
