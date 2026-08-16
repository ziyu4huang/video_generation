---
effort: 2026-08-16-tool-gate-qa-harness-generalization
created: 2026-08-16
last: 2026-08-16
---

# Spec — tool-gate QA harness generalization

Source of truth for decisions: `map.md` + `tickets/01–04`. This spec fixes the
contract shapes and the acceptance bar; tickets decide and execute.

## 1. The problem, restated

The harness is correct but bespoke: `qa/collect-probes.ts` enumerates 25 static
imports + a 33-entry array; `qa/evaluate.ts` enumerates ~20 imports + 4 stub
registrars + a 20-entry registrar array; probe data lives scattered across 12
owning extensions under two export conventions. Ticket 01 already built the
shared `GATE_DEFS` registry — the harness is the last place that re-lists what
the registry already knows.

## 2. The target shape (recommended)

### 2.1 Probe contract joins core-interface as a **parallel registry**

`GateProbeSet` moves from `qa/collect-probes.ts` to core-interface, and probe
data moves from scattered `__GATE_PROBES__` / named-const exports into a single
parallel registry beside `GATE_DEFS`:

```ts
// core-interface/src/gates.ts  (extended)
export interface GateProbeSet {
  gate: string;                    // canonical family id (== GATE_DEFS key)
  recallFloor?: number;            // default 0.9; 0 = controls-only
  adversarial: string[];           // realistic "I need this" phrasings, no current keyword
  controls: string[];              // keyword/requires-satisfying phrasings, MUST fire (100%)
}
export const GATE_PROBES: Record<string, GateProbeSet> = {};
```

Rationale for **parallel** (not folding probes *into* `Gate`): probes are QA
test data, not runtime gating semantics. Keeping them in a sibling export keeps
`Gate` (and thus `buildEffectiveGates` / `enable_tool`) free of QA strings, while
still living in the shared leaf package — which ends the "PLAIN object, no type
import" circular-dep workaround and the `__GATE_PROBES__` vs named-const split.

An owning extension declares both in one place:

```ts
GATE_DEFS["flux2"] = { id: "flux2", keywords: [...], requires: {...}, description: "..." };
GATE_PROBES["flux2"] = { gate: "flux2", adversarial: [...], controls: [...] };
```

### 2.2 Collector derives, not enumerates

`qa/collect-probes.ts` collapses from 25 imports + 33-entry array to:

```ts
import { GATE_PROBES } from "@repo/pi-agent-core-interface";
export const ALL_PROBE_SETS: GateProbeSet[] = Object.values(GATE_PROBES);
export const PROBES_BY_GATE: Map<string, GateProbeSet> =
  new Map(ALL_PROBE_SETS.map((p) => [p.gate, p]));
```

The import list of owning extensions stays only in `evaluate.ts` (it must drive
their registrars to build `CORPUS_GATES`) — but the *probe* bookkeeping goes away.
Because tool-gate already imports every owning extension via `evaluate.ts`, the
`GATE_PROBES` registry is populated by the time `evaluateGateRecall` runs.

### 2.3 Drift-guard becomes id-equality

`qa/collect-probes.test.ts` today re-implements `sigOf` (JSON-stringify keywords/
requires). Under the id-referenced contract, grouping is already by id, so the
guard becomes: every `GATE_PROBES` key ∈ `GATE_DEFS` (and vice-versa, via the
existing reverse invariant in drift-guard), and each probe set is well-formed.

## 3. Acceptance bar (semantics-preserving)

- `bun run qa --strict` **byte-identical** output before/after (same savings
  15,186 tok, same L1 tallies, same gate-recall 32/32, same coverage 0 ungated).
- `bun test` green in tool-gate, core-interface, and all 12 owning extensions.
- No `__GATE_PROBES__` / named-const probe export remains in any owning extension;
  the only probe registry is `GATE_PROBES` in core-interface.
- The drift-guard no longer contains a `JSON.stringify` signature reconstruction.

## 4. Scope ladder (what each ticket owns)

- **01** decides *where* the probe contract lives (the 2.1 shape vs alternatives).
- **02** executes the migration + collector derivation (2.1 + 2.2).
- **03** relocates the `GateProbeSet` type + simplifies the drift-guard (2.3).
- **04** (fog) investigates `evaluate.ts` registrar-manifest generalization.

## 5. Alternatives considered (for ticket 01)

- **(A) Fold probes into `Gate`** (`Gate.probes?`). Single object per family, but
  QA strings ride the runtime contract into `enable_tool`-derived prose paths and
  any future `GATE_DEFS` serialization. Rejected-leaning.
- **(B) Keep probes in owning extensions, export via a single manifest** (e.g. a
  `qa-probes.ts` barrel). Reduces scatter but keeps the cross-package import
  bookkeeping (the barrel is the 25-import list, just relocated). Weak win.
- **(C) Parallel `GATE_PROBES` registry in core-interface** (2.1). Recommended:
  QA data stays out of runtime semantics, one shared leaf-package location, ends
  the type-workaround, and enables 2.2's derive-not-enumerate.
