**ID:** `ADR-tool-gate-0005` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0005: Remove the phantom `cost` gate

Date: 2026-07-25 (audit)
Status: accepted
Amendment (2026-08-10): `movie-director-cost.ts` was deleted, so the Decision's "unless it is wired to actually load at runtime" condition no longer has a subject.
See: inline NOTE in `extensions/tool-gate.ts` (the `cost` gate block)

## Context

A `cost` gate existed, gating the `movie-director-cost.ts` typed prototype. But that file is **measured offline** (the schema-cost CLI's `EXTRA_ENTRIES`) yet **never loaded at runtime** — it is absent from `bun-apps/pi-agent/run-dir/manifest.json`, from `src/static-extensions.ts`, and from `movie-director.ts`'s imports. Gating a tool that never registers is phantom accounting: the gate "saves" tokens that were never spent, inflating the reported savings by **~536 tok/req**. The headline savings number was thus dishonestly high.

## Decision

**Remove the `cost` gate.** The real cost functionality lives in the `movie` extension's cost subcommands, already covered by the `movie` gate. Do **not** re-add a `cost` gate unless `movie-director-cost.ts` is wired to actually load at runtime.

## Consequences

- The savings figure (`bun run qa:savings`) reflects only tools that **actually load** — an honest baseline. (This is part of why the current ~7,940 tok/req gross is trustworthy.)
- The audit rationale is preserved as an inline NOTE in `tool-gate.ts` at the former gate block, so a future contributor re-adding it sees why it was removed.
- Reinforces a general invariant: **a gate must gate a tool that actually registers.** The coverage QA axis (`qa/coverage.ts`) is the structural backstop — it finds ungated heavy tools; the cost-gate case was the inverse (a gate for a non-tool).

## Alternatives considered

- **Keep the gate** (it "saved" tokens). *Rejected:* the savings were phantom — the tool never loaded, so nothing was saved. Inflates the headline dishonestly.
- **Wire `movie-director-cost.ts` to load at runtime and keep the gate.** *Rejected:* scope creep; the prototype is intentionally offline-measured (it's a typed schema probe, not a runtime tool). If it ever becomes runtime-loaded, re-add the gate then.
