---
type: grilling
claimed: continue-improve (2026-07-26)
status: closed
blocked by:
  - 01-missing-config-contract
  - 04-preset-validation-design
---

# 06 · Config-load validation

## Question

Should `loadModelTierConfig` **validate** that loaded tier/capability specs are resolvable (provider exists in `models.json`) at load time — warning or rejecting broken specs?

This is the load-time analog of preset-validation (04): 04 checks at apply-time (write), 06 checks at read-time (load). Together they keep the config honest whether it was hand-edited, preset-written, or stale.

## Decisions (reuse 04's mechanism + 01's contract)

1. **Where**: inside `loadModelTierConfig` (subagent/src/model-role-config.ts)? or a separate `validateModelTierConfig` called by loaders? — prefer a pure validator callers opt into, to avoid surprise side-effects on every read.
2. **Severity**: reuse 01's contract (throw/prompt/fallback) — if 01 chose throw, load-time warns + resolve-time throws; if fallback, load-time warns only.
3. **Scope**: validate `tiers.{small,medium,big}` + `capabilities.vision` provider prefixes against the 04 helper's provider set.

## Context

- Currently `loadModelTierConfig` parses + returns, zero validation. A config with a typo'd provider (`zia/...`) silently fails downstream — the user discovers it only when a resolution returns garbage or throws.

## Dependencies

- **01** (contract): decides what "invalid at load" does.
- **04** (mechanism): the models.json-reader helper is built there; 06 reuses it.

## Acceptance

A decided load-validation design (pure validator vs. inline, severity per 01, scope), reusing 04's reader, with hand-edited/stale configs surfaced at load rather than failing silently downstream.

## Resolution (2026-07-26)

Fact-driven: `loadModelTierConfig` is on the **hot resolution path** (8 callers incl. `resolveVisionLLM`/`spawn-subagent`/`agent`) with **no cache** (reads disk every call) → throwing OR warning inside it is disruptive (single bad spec bricks all resolution; warn spams every page). So **load stays pure**; validation fires at interaction points.

### `loadModelTierConfig` — UNCHANGED (pure parse)

Keeps doing structural validation only (tiers/capabilities are objects of strings) + returns `null` on absent/unparseable. **No catalog check, no throw, no warn.** Adding any would mix concerns into a leaf called on every resolution.

### Reuses 04's `validateConfigSpecs` — no new logic

06 is **wiring**, not a new validator. The `validateConfigSpecs(config, known?)` from `models-registry-reader.ts` (04) is the single source of truth for "is this spec catalog-known".

### Fire points

1. **`session_start` hook** (subagent extension `pi.on("session_start", …)`): load config + `validateConfigSpecs` + warn **once per session** (session_start fires once → no dedup state needed) if any spec is unresolvable. Early, non-spammy.
2. **`/workflows-models`** (workflow extension): show **✓/⚠** per tier/capability when displaying. The tier picker draws from `listAvailableModelSpecs()` so picks are inherently catalog-valid — **save-time reject is moot**; the ✓/⚠ display catches specs that entered via **hand-edit** (bypassing the picker).
3. (`/models-preset` stays **reject-hard** at write-time — that's 04.)

### Scope boundary — resolve stays as 01

06 does **NOT** add catalog validation to the resolve path (`resolveVisionLLM`/`resolveLLM`). Reasons: (a) resolve is hot — a catalog read (models.json + models-store.json) on every call doubles file I/O; (b) it would extend 01's closed contract. A bad spec that bypasses all three surfacing points (ignored the session_start warn, never opened `/workflows-models`, not from a preset) still fails at **runtime** with a clear "model not found" — acceptable last resort. **06 = load/interaction validation; resolve = 01's domain.**

### Severity

**Warn** everywhere 06 touches (session_start + ✓/⚠ display) — never throw at load. The only reject-hard in the system is `/models-preset` write-time (04).
