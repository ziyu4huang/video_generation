---
effort: 2026-08-16-tool-gate-qa-harness-generalization
created: 2026-08-16
last: 2026-08-16
status: active
---

# Map — tool-gate QA harness generalization

## Destination

Generalize the tool-gate QA harness (`qa/*` — savings / coverage / corpus / gate-recall / l2) so that probe sets and gate coverage **derive from the shared registry** instead of hand-maintained static import lists, and the harness becomes a pattern any gated extension gets **for free** — WITHOUT regressing the QA safety net (`qa --strict` byte-identical; semantics-preserving).

One line: **end the "one import line + one array entry per gate" bookkeeping that scattered across tool-gate and 12 owning extensions, by making the registry (which ticket 01 already built) the single source the harness derives from.**

## Notes

**Domain.** tool-gate's QA harness is the safety net around gating. It has five axes, all under `bun-apps/pi-agent-ext-tool-gate/qa/`:

| axis | file | what it measures | coupling today |
|---|---|---|---|
| savings | `savings.ts` | OFF vs ON tok/req + `enable_tool` overhead + claimed/deviation | `buildSchemaCostReport` (no per-gate coupling) |
| coverage | `coverage.ts` | heavy (≥300 tok) tools NOT tracked by any gate | `CORPUS_EFF.tracked` (derived from corpus) |
| corpus (L1) | `evaluate.ts` | must-fire / must-not-fire / escape cases | **~20 static imports + 4 stub registrars + 20-entry registrar array** |
| gate-recall | `gate-recall.ts` + `collect-probes.ts` | adversarial recall + control-fire per gate group | **25 static imports + 33-entry `ALL_PROBE_SETS` + hand-built `PROBES_BY_GATE`** |
| l2 | `l2.ts` + `l2-tasks.ts` | reachability (deterministic) + live A/B | task fixtures only (no per-gate coupling) |

**The bespoke-ness (review.md F11, now the target).** Two files carry the coupling:

1. `collect-probes.ts` — 25 `import { __GATE_PROBES__ … }` lines + a 33-entry `ALL_PROBE_SETS` array + `PROBES_BY_GATE` map. Adding a gate = 1 import + 1 array entry. Probe *data* lives scattered in the owning extensions (`flux2.ts`, `ltx.ts`, `research-tool.ts`, `devops.ts`, hermes-memory's 6 tool files, …). Export naming is inconsistent: single-gate packages use `__GATE_PROBES__`, multi-gate packages use named consts (`COLLECT_VIDEOS_PROBES`, `PI_DEPLOY_PROBES`, …).
2. `evaluate.ts` — ~20 extension-entry imports + 4 stub registrars (`zaiRegistrar`, `hermesMemoryRegistrar`, `coreTaskRegistrar`, `webuiPresentRegistrar`) + a 20-entry registrar list, to drive `captureOwnerDeclaredDefs` → `CORPUS_GATES` / `CORPUS_EFF`.

**What the contract (ticket 01) already gave us — the graduation trigger.** `GATE_DEFS` is now a **shared mutable registry** in `@repo/pi-agent-core-interface` (`gates.ts`): `export const GATE_DEFS: Record<string, Gate> = {}`, populated at import time by each owning extension (`GATE_DEFS["flux2"] = { id, keywords, … }`). tool-gate reads it; the drift-guard asserts every referenced id is known and every declared id is referenced. That is exactly the "derive, don't enumerate" substrate the harness lacks — the registry already groups by id, so the harness no longer needs to re-derive grouping from `sigOf` JSON-stringify.

**`GateProbeSet` lives in tool-gate today** (`collect-probes.ts`) as a deliberate lean: extensions export PLAIN objects (no type import) to avoid a circular dep on tool-gate. Once probes move beside `GATE_DEFS` in core-interface, that workaround (and its no-type-safety cost) disappears.

**Prior verdicts (cite, don't re-decide).**
- map.md of `2026-08-15-tool-gate-complete-redesign` §"Not yet specified": *"Generalize the QA harness … into a reusable gated-extension framework — gate-recall probe sets currently live scattered in the owning extensions (flux2/ltx/research-tool). **Graduates only if the contract redesign (ticket 01) shows real cross-extension reuse value.**"* → **Graduated**: 12 extensions now declare `GATE_DEFS[id]` + probes in one uniform pattern; the shared registry is the reuse proof.
- ticket 00 (matching mechanism) ruled **KEEP keyword + noun∧verb** — this effort does not touch the matcher; it only changes *how probes/corpus are collected and grouped*.
- ticket 01 established **semantics-preserving migration is the bar**: `qa:savings` + `qa:gate-recall` stayed byte-identical across the 01a→01c contract change. This effort inherits that bar.

**Standing preferences (inherited from the redesign effort).** Breaking allowed only where the change keeps the QA corpus byte-identical (the corpus is the contract's spec). Keep the mutate/pure split and fail-open posture. `bun run qa` + `bun test` are the gate — never hand-assemble a subset. One canonical QA entry (`qa/run.ts`). ADRs cite as `ADR-tool-gate-NNNN`; any contract/model change carries a docs ticket in the same rollout (CONTEXT NO-DRIFT invariant).

## Decisions so far

- (none yet — this is a fresh effort; the frontier is the probe-contract-location decision, ticket 01.)

## Not yet specified

- **Corpus-builder generalization (`evaluate.ts`)** — the ~20 registrar imports + 4 stub registrars are the harder half. Whether a per-extension `CORPUS_REGISTRAR` export (or manifest-driven discovery) can replace them is fog; graduates only after tickets 01–03 show the "derive from the shared package" pattern holds for probes.
- **Extracting the harness into a reusable `qa-kit` package** — graduates only if a *second* gated-extension family materializes that would reuse it. Until then the harness stays in tool-gate (still the only gating owner).
- **Live L2 measurement** (`qa --l2 --model X`) — armed but never run (no model in this env); unrelated to generalization, unchanged by this effort.

## Out of scope

- **The matcher** (keyword + noun∧verb) — ticket 00 kept it on evidence; generalization must not change fire semantics.
- **The gated tools themselves** — flux2/ltx/krea2/… are owned by their extensions; this effort only moves how their *probes* are collected.
- **runtime gating behavior** (`extensions/tool-gate.ts`, per-session state, `__piToolGateStatus`) — the redesign (tickets 05/06) already landed it; the harness is QA-only.
- **`enable_tool` overhead reduction** and **upstreaming `gating` into pi-coding-agent** — separate fog items, not this effort.
