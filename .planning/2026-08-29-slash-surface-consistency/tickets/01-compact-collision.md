# 01 — /compact collision adjudication

blocking: none (FIRST — its naming outcome feeds 03)

## What

Pi 0.84.4 ships builtin `/compact`; s2-agent-ext-compact registers a command
named `compact` (registry-config.ts:590). Measure which one answers in the
TUI and whether the extension's CC-style semantics survive 0.84.3's
compaction-routing changes.

## Approach

1. Boot `./s2-agent.sh` (or deployed current) with the compact extension
   loaded; probe the command registry (colliding-command-dispatch patch in
   src/patches/ may already arbitrate — READ it first).
2. Record a measurement receipt: winner, dispatch path, semantic differences
   (CC-style vs upstream routing).
3. Decide rename (`/compact-cc`) vs deliberate shadow (documented + tested).

## Done when

- [ ] Measurement receipt in the ticket (or map Context) naming the winner
- [ ] Decision recorded in map ## Decisions
- [ ] Regression test pins the chosen behavior
- [ ] Package gates green (canonical `bun run test` of touched packages)
