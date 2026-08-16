# 01 — First-class gate contract (kill ambient-global + fingerprint reconstruction)

type: research
claimed: dsh-main (2026-08-15)

## Question

Today a "gate" has **no first-class representation**. `buildEffectiveGates` (`extensions/tool-gate.ts:110-131`) splits every owner-declared non-core tool into a *single-name gate*; co-firing siblings are re-collapsed **only** by structural fingerprint equality — `gateGatingKey`/`gatesWithSameGating` (`tool-gate.ts:330-353`) JSON-stringify sorted keywords/requires and match on byte-equality. `Gating` itself is a `declare global` ambient type (`core-interface/src/tool-gating.d.ts:48-58`).

This creates three real defects:
- **Spec B hazard**: `movie` and `movie_help` carry verbatim-duplicated `gating`; editing one side silently breaks sibling co-activation (a `gating-siblings.test.ts` net guards it, but only in tests).
- **F8**: `enable_tool`'s `description`/`promptGuidelines` re-hardcode a prose list of gated domains, drifting from the actual gates.
- **Ambient-global fragility**: `Gating` is invisible to imports; consumers must thread the augmentation via tsconfig `types` or triple-slash directives (the contract-collapse spec documented this whole migration).

Resolve:

1. **What is the first-class shape?** Options to weigh:
   - a declared `Gate`/`ToolFamily` object (id + keywords + requires + description) exported from `core-interface`, with each tool declaring `gating: { gate: "flux2" }` (reference by id) instead of inlining keywords per-tool.
   - a runtime **gate registry** (extension API: `registerGate`/`getGates`) that tool-gate reads, replacing `buildEffectiveGates`'s per-def reconstruction.
   - keep the per-tool `gating` field but add an explicit `group`/`family` id to end fingerprint reconstruction.
2. **Where does it live?** `core-interface` is the single shared contract package — decide whether the gate contract joins it (and whether `Gating` stops being ambient-global and becomes a real exported type).
3. **How does `enable_tool` derive its description/list from the contract** instead of hardcoded prose (F8)?
4. **Back-compat vs breaking**: the user allows breaking; decide how much of the 14-extension declaration surface migrates in one rollout and whether a mechanical codemod suffices.

Produce a contract proposal (shape + location + migration plan + the test/guard that replaces `gating-siblings.test.ts`).

blocked by: none

## Resolution

**First-class gate contract: id-referenced gate families + a shared exported registry in `core-interface`.**

Recommendation (research; the final shape is HITL-confirmable):

1. **Export the contract.** Replace the ambient-global `Gating` with a real exported `Gate` type in `@repo/pi-agent-ext-core-interface`. Importable — this ends the tsconfig-`types`/triple-slash fragility the contract-collapse spec (Spec A) documented.
2. **A gate is a first-class object** `{ id, keywords?, requires?, description }`, declared **once**. Co-firing groups are named by id. Sibling tools declare `gating: { gate: "<id>" }` (reference) instead of inlining keywords per-tool; `core:true` tools stay `gating: { core: true }` (no id).
3. **Shared registry.** Gate defs live in an exported registry (`GATE_DEFS` map, or `registerGate`) in `core-interface`. `buildEffectiveGates` collapses to a single group-by-id pass — **deleting `gateGatingKey` and `gatesWithSameGating`** (the fingerprint-JSON reconstruction).
4. **`enable_tool` derives its list + description from the registry** — no hardcoded domain prose (F8).

This kills three defects at the root: **Spec B** (movie/movie_help verbatim duplication → edit the gate once, every reference follows), **F8** (`enable_tool` prose drift), and the **ambient-global fragility** (F3).

Evidence the direction is already emerging: `#1464` (origin/main `c18f0363`) re-architected power-tool and introduced `src/gating.ts` — a single shared `DIAGNOSTIC_GATING` object referenced by all six `inspect_*` tools. That is exactly the "shared def + reference" pattern this ticket formalizes, generalized across extensions and given an id + registry.

**Migration (mechanical):** 14 owning extensions move their inline `gating:{keywords,requires}` into `GATE_DEFS[id]` and declare `gating:{gate:id}`. Guards update: drift-guard asserts "every gate id is referenced by ≥1 registered tool, and every gated tool references a known id"; the `gating-siblings.test.ts` fingerprint net is **deleted** (same-id ⇒ same-family is now trivial). `qa:savings` + `qa:gate-recall` must remain byte-identical (the migration is semantics-preserving — same keywords/requires, same co-firing).

**Unblocks:** 03 (declare new-shape gating), 04 (docs), 05 (session_start reads the registry once), 06 (introspection reads the registry).

closed: 2026-08-15 (id-referenced gate families + shared registry in core-interface)
