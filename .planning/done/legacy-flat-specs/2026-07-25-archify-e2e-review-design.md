# Archify Extension — Integration-Layer E2E + Defect Hunt (Design)

- **Date:** 2026-07-25
- **Scope:** `bun-apps/pi-agent-ext-archify/`
- **Status:** Approved (design)
- **Context:** Post-#791 — all unit-level defects (A1–A7) fixed and merged. The
  remaining untested seam is the **pi-coding-agent integration layer**: does
  `extensions/archify.ts` register correctly, and does the `defineTool`-wrapped
  `execute()` boundary + `ctx` wiring actually work end-to-end (IR → HTML →
  receipt on disk)? Existing unit tests call lib functions directly
  (`archifyRender(params, ctx)`); none drive the registered tool boundary.

## Goal

Add an opt-in integration e2e that drives the registered archify tools through
`execute()` over the full IR → vendored CLI → on-disk artifact path, then
distill the run into a findings report to surface any defects still latent at
the integration layer (misleading tool text, uncaught throws across the
`defineTool` wrapper, diagram types that fail only at dispatch time).

## Non-goals

- No LLM agent loop (Goal = integration layer, settled).
- No changes to `lib/` or `vendored/` in this step — defect *fixes* belong to a
  follow-up plan. This step only *adds* the test + report.
- No golden HTML snapshotting (high maintenance on vendored re-sync, and not
  the objective).

## File layout

- **New:** `bun-apps/pi-agent-ext-archify/__tests__/e2e.test.ts` — single file,
  three `describe` blocks (Layers 1–3) + negative cases, gated by
  `PI_AGENT_E2E=1` with `describe.skip` default (matches
  `pi-agent-ext-deploy/__tests__/e2e.test.ts`).
- **New:** `bun-apps/pi-agent-ext-archify/receipts/archify-e2e-<date>.md` — the
  findings report produced from running the gated suite (follows the
  `pi-agent-ext-movie-director/receipts/` convention).
- **Existing reused:** `__tests__/fixtures/mini.architecture.{json,v2.json}`,
  `vendored/examples/*.json`.

## Test layers

### Layer 1 — Registration contract (recorder-pi)

Mirror `pi-agent-ext-btw/__tests__/registration.test.ts`: build a fake `pi`
that records `registerTool` calls; invoke the default `ExtensionFactory`
(`extensions/archify.ts`); assert the registered tool names are exactly
`{archify_render, archify_validate, archify_delta}` (order-independent). Locks
against dropped / duplicate / renamed tools — the boundary that silently breaks
most often. Capture the registered tool objects for Layer 2.

### Layer 2 — Dispatch integration (the core gap)

Call `execute(toolId, params, signal, onUpdate, ctx)` on the **registered tool
objects captured in Layer 1** (not on lib functions directly) so the test
proves both "the registered object is this tool" and "the `defineTool`-wrapped
`execute()` + `ctx` wiring works". One happy path per tool, in a temp `cwd`:

| Tool | Params | Assertions |
|------|--------|------------|
| `archify_render` | `{ ir: fixture, type: "architecture" }` | `content[].text` contains the output path; HTML file exists on disk and is non-empty (single self-contained file, no external/network asset refs); `details.artifact` + `details.validation` present |
| `archify_validate` | `{ ir: fixture }` | `isError` falsy; text contains "valid"; `details.report.composition` present |
| `archify_delta` | `{ basePath, headPath }` (two architecture IR files) | HTML + `.receipt.json` sidecar produced; `details.receipt` points to an existing file |

### Layer 3 — Cross diagram-type matrix

Data-driven table `[{ type, example }]`, one vendored example per type:
`architecture`, `sequence`, `workflow`, `dataflow`, `lifecycle`. For each, run
`render`'s `execute()` and assert an HTML artifact is produced, then run
`validate`'s `execute()` and assert it passes. Confirms the vendored renderers
are all reachable at dispatch time (not just `architecture`).

**Granularity:** one example per type (5 render + 5 validate). Broader
coverage (all 13 vendored examples) is a YAGNI for this step; the matrix can be
expanded later if a type fails.

## Negative cases (via `execute()`)

Emphasize "still correct after crossing the `defineTool` wrapper" (the wrapper
swallowing errors is a common regression point):

- `archify_delta` with a non-architecture `type` → `isError: true`, clear
  message, no throw.
- `archify_render` with a malformed IR → bin exits non-zero, surfaced as an
  honest error (no uncaught exception).
- An already-aborted `AbortSignal` → `status !== 0`, never reports success.

## Error handling & resource cleanup

- Temp `cwd` via `mkdtempSync`; `afterAll` removes all created dirs (matches
  deploy's pattern).
- `AbortSignal` via a fresh `AbortController` (pre-aborted for the negative
  case).
- Per-spawn timeout 30s (vendored bin is ~hundreds of ms; generous headroom).

## "Review results" output

Running `PI_AGENT_E2E=1 bun test __tests__/e2e.test.ts` yields a findings report
at `receipts/archify-e2e-<date>.md`:

- **Matrix:** `(tool × diagram-type)` pass/fail.
- **Findings:** any misleading returned text, any uncaught throw across the
  `defineTool` wrapper, any type failing only at the integration layer — each
  with reproduction + severity.
- **Verdict:** whether the integration layer is trustworthy today + follow-up
  recommendations (feeds the next implementation plan).

## Gating & success criteria

- Gate: `PI_AGENT_E2E=1`; default `bun test` and CI skip the suite.
- Pass: Layers 1–2 green; Layer 3 matrix green. A vendored renderer failing at
  the integration layer is a **finding**, not a broken test.
- No edits to `lib/` or `vendored/` — pure test + receipt addition.
