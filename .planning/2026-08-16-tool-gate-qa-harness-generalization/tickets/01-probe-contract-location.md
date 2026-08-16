# 01 — Probe contract location (parallel registry vs fold-into-Gate vs barrel)

type: research
claimed:
blocked by: none

## Question

`GateProbeSet` + probe data today live **scattered**: the type in tool-gate's
`qa/collect-probes.ts`; the data as `__GATE_PROBES__` (single-gate packages) or
named consts (multi-gate: research-tool `COLLECT_VIDEOS_PROBES`/`ARXIV_SEARCH_PROBES`,
devops ×9, hermes-memory ×6). Extensions export PLAIN objects with no type import
to avoid a circular dep on tool-gate — so probe shape is only enforced by a
drift-guard test, not the compiler.

Ticket 01 (the contract) already built `GATE_DEFS` in core-interface as the shared
mutable registry. Decide where the *probe* contract joins it:

- **(A) Fold probes into `Gate`** (`Gate.probes?`) — one object per family, but QA
  strings ride the runtime contract (risks leaking into `enable_tool`-derived prose
  or any future serialization of `GATE_DEFS`).
- **(B) Barrel in each extension** — keep probes in extensions, export via a
  `qa-probes.ts` barrel. Reduces scatter but keeps the cross-package import
  bookkeeping (relocates the 25-import list, doesn't kill it).
- **(C) Parallel `GATE_PROBES` registry in core-interface** (spec §2.1) — QA data
  stays out of runtime `Gate` semantics, lives in the shared leaf package (no cycle),
  ends the PLAIN-object no-type-import workaround and the export-naming split, and
  enables derive-not-enumerate in ticket 02.

Resolve: (1) which shape; (2) where `GateProbeSet` the type lives; (3) the migration
order that keeps `qa --strict` byte-identical at every step (mirror 01b's expand-then-
contract: add the parallel registry beside the scattered exports, migrate one
extension at a time, delete the scattered exports last).

Produce a recommendation + the exact core-interface additions (signature-level).

## Resolution

(open)
