---
effort: 2026-09-10-archify-envelope
created: 2026-09-10
last: 2026-09-10
status: active
---

# Wayfinder map: 2026-09-10-archify-envelope — envelope completeness + aspice evidence gates

## Destination

The deck pack/unpack story completes: `--inline-ir` lets ONE canonical JSONL
envelope carry the diagram IR bodies (an unpacked folder builds standalone,
no original tree needed), and the aspice4-alm evidence workflow is pinned by
gates (slideCount mutation refusal, append/edit → repack → rebuild).

## Context

Plan (GLM-5.3 planner):
`.planning/plans/2026-09-10-archify-envelope-plan.md`. Queues: #2241 t03
follow-up (`--inline-ir`) + aspice-alm review pass 2 (F7 evidence gates,
OBS-1 pin landed in #2262's drift-pin test). Give-up criteria are written
in the plan (byte-stability break / round-trip leak / overwrite deadlock).

## Tickets

- [ ] T1 — `tests/aspice4-alm.test.ts`: slideCount mutation refusal +
  append/edit → repack → rebuild evidence gates (test-only)
- [ ] T2 — `deck-pack.ts` inline-ir core (IrRecord / PackOptions / irFiles;
  pure lib layer; 8 contract tests)
- [ ] T3 — CLI `--inline-ir` + standalone-build e2e + docs

## Decisions

- D1: inline IR records carry content verbatim; NO per-record hash (irCount +
  repack byte-identity are the integrity pair; sha256 is additive-later).
- D2: `irCount` appears in the header ONLY when > 0 — committed
  assessment.deckl bytes must not change.
- D3: authored relative paths (incl. `..`) resolve against the unpack dir;
  absolute paths refused at pack AND unpack.

