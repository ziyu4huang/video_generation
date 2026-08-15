---
type: grilling
claimed: pi-agent (autonomous — user pre-agreed, option B)
status: closed
---

# 01 — Single home for spec.md (retire the docs/specs/ alt)

## Question

`to-spec` (wayfind) currently offers TWO write locations for the spec:

> write it to a local file — `.planning/<effort>/spec.md` (**or `docs/specs/<slug>.md`** if you prefer a repo-committed location)

Meanwhile superpowers' `brainstorming` skill writes its design doc to exactly `.planning/<effort>/spec.md` — no alt. So the `docs/specs/` alt is the **one real wayfind-side divergence** from the unified home.

**Decide:** retire the `docs/specs/<slug>.md` alt so `spec.md` is single-homed at `.planning/<effort>/spec.md`?

### Recommendation

**Retire the alt.** Reasons:

- It is the only wayfind artifact that can land outside `.planning/`; killing it completes "all effort-scoped planning artifacts under `.planning/<effort>/`."
- It removes the ambiguity of two producers (wayfind `to-spec` + superpowers `brainstorming`) writing the *same* `spec.md` artifact to *different* default roots — after this, both write to `.planning/<effort>/spec.md` by default.
- The "repo-committed location" rationale for `docs/specs/` is already served: `.planning/` is repo-committed.

### Side-confirm (fold into this decision)

Are wayfind `to-spec`'s spec (a PRD) and superpowers `brainstorming`'s design doc **the same artifact** (both → `.planning/<effort>/spec.md`)? The vault SOP doc treats them as one; confirm so the doc can state it unambiguously.

### On resolution

Edit `pi-agent-ext-wayfind/skills/to-spec/SKILL.md` to remove the `docs/specs/` alt (single path: `.planning/<effort>/spec.md`). That edit is the superpowers execution hand-off — not part of this ticket.

## Resolution (closed 2026-07-19 — autonomous, user pre-agreed with recommendation)

**Retire the `docs/specs/<slug>.md` alt.** `spec.md` is single-homed at `.planning/<effort>/spec.md`.

- **Side-confirm resolved:** wayfind `to-spec` (PRD) and superpowers `brainstorming` (design doc) **ARE the same artifact** — both write `.planning/<effort>/spec.md`. The vault SOP doc ([04](04-sync-docs-to-reality.md)) states this unambiguously.
- **Hand-off edit:** `pi-agent-ext-wayfind/skills/to-spec/SKILL.md` — delete the `（或 docs/specs/<slug>.md）` alt clause (line ~3 of the to-spec Process). → see change-list in map close.
