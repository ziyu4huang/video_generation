---
ticket: 01
status: done
blocked-by: []
---

## Goal

Establish a read-only baseline for acceptance accounting before any code changes.

## Scope

- Produce a 25-item feature checklist keep/cut matrix derived from spec decisions D1-D8.
- Measure current schema-cost of ALL 10 registered tools using `bun-apps/pi-agent/src/cli/commands/schema-cost.ts discoverExtensionEntries`.
- Count LOC per `src/` module of `pi-agent-ext-hermes-memory`.

## Acceptance

- Matrix and all measurements written to `.planning/2026-08-16-hermes-leanrag-simplify/baseline.md`.
- No code changes in this ticket.
