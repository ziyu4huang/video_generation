# 03 — Relocate `GateProbeSet` type + simplify the drift-guard to id-equality

type: task
claimed:
blocked by: 01

## Task

Two follow-throughs once probes live in core-interface (ticket 01/02):

1. **Type relocation.** Move the `GateProbeSet` interface from
   `qa/collect-probes.ts` into core-interface (`gates.ts`), exported alongside
   `Gate`/`Gating`/`GATE_DEFS`. Delete the "PLAIN object, no type import" comment
   workaround; extensions now import the real type (no cycle — core-interface is
   the leaf).
2. **Drift-guard id-equality.** `qa/collect-probes.test.ts` re-implements `sigOf`
   (`JSON.stringify({keywords, requires})`) to detect duplicate probe sets per
   co-fire group. Under the id-referenced contract, grouping is already by id, so:
   - replace the signature-JSON check with "every `GATE_PROBES` key is a known
     `GATE_DEFS` id, and every probe set is well-formed (string gate, arrays, ≥1
     control)";
   - keep the reverse invariant (every declared id with probes is referenced) in
     `extensions/drift-guard.test.ts`.

**Acceptance**: no `JSON.stringify` signature reconstruction remains in the QA
guard; `bun test` green (tool-gate + core-interface); `qa --strict` byte-identical.

## Resolution

(open)
