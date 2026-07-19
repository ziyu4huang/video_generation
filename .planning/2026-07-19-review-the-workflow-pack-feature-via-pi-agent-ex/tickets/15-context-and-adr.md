## Question

Update the extension's **`CONTEXT.md`** ubiquitous language + create the **ADR(s)** for hard-to-reverse decisions surfaced (at minimum the state-model ADR flagged in 03).

type: task
status: closed

blocked by: 05(closed), 08(closed)

## Context

New terms enter the domain: *pack-local state*, *folder template*, *I/O contract*, *bundled agents*, *pack-id*/*version*. `domain-modeling` says capture them in `CONTEXT.md` as they crystallize and write an ADR when a decision is hard-to-reverse + surprising + a real trade-off. 03 (pack-local state, diverging from the cwd-keyed global store) clears that bar → `bun-apps/pi-agent-ext-workflow/docs/adr/0001-pack-local-state.md`. Other candidates (the determinism-vs-on-disk-intermediates trade-off from 12, the pack-id scheme from 08) may qualify once resolved. This ticket is the documentation close-out; do it after the core design (05, 08) settles so the glossary is stable.

## Resolution

- **CONTEXT.md glossary** — added a "Workflow pack self-containment" subsection capturing all new terms: pack-local state, `pack-id`, `version`, checked-in state redirect, I/O contract (`io:`), bundled agents (`agents/*.md` + `packDirs`), folder template, clean/inspect (3-tier safety), on-disk intermediates (opt-in mirror).
- **ADR-0001** (state-model, 03) — pack-local, never `~/.pi` (written earlier).
- **ADR-0002** (pack-id scheme, 08) — path-resolved hash, version-INDEPENDENT. Clears the ADR bar (hard-to-reverse + surprising + real trade-off: `name@version` rejected because a version bump orphans history).
- **12 (determinism vs on-disk intermediates)** — NOT a separate ADR: it RESOLVED a perceived tension (journal is canonical, the on-disk mirror is disposable — no real trade-off remains), and is already captured as a consequence in ADR-0001 + the CONTEXT "on-disk intermediates" term.
