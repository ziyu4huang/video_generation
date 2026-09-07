# t02 — workflow rows labeled + abortable on the shared surfaces

## (a) Verified findings

- `workflow-manager.ts` `registerInFlight` (~:784) passes NO `abort` — so
  `RunView.abortable` (run-view.ts) is false for every `wf:` row and the
  /subagents viewer's x-key abort (`onAbort` → `registry.abort(id)`,
  subagents-command.ts) is a silent no-op on workflows. Real levers exist:
  `WorkflowManager.stop(runId)` / `pause(runId)`.
- `subagent-viewer.ts` has ZERO workflow awareness (grep `wf:|workflow|Workflow`
  → no hits): `wf:` rows render as ungrouped rows, actor `"workflow"` (from
  `agent: "workflow"`), no badge, no model segment.
- `subagent-tool-render.ts` likewise (grep → no hits): the registry docstring's
  promised "workflow-specific header" in the context box does not exist
  (doc-code drift).
- The above-editor dock `bun-apps/s2-agent-ext-task/src/subagents/subagents-section.ts`
  renders `registry.views({ foreground: false })` through `renderRunRow`
  (agent-row-display.ts:187) — badge support already exists (`v.badgeText`,
  fixed-width `padEnd(8)` variant at :211).
- ID keyspaces are disjoint by `workflowInFlightId` (`wf:` prefix,
  workflow-manager.ts:58) — string matching on the id is safe but better
  expressed as data.

## (b) Implementation steps

1. core-runtime `subagent-in-flight.ts`: add optional record field
   `kind?: "workflow"` (set once at start; `wf:` prefix stays the id-space
   guarantee, not the type marker). `run-view.ts`: `RunView.kind?: "workflow"`
   passthrough in `buildRunView`; `badgeText` computation sets `"workflow"`
   for kind==="workflow" when no other badge claims the slot.
2. ultracode `workflow-manager.ts` `registerInFlight`: pass
   `kind: "workflow"` and `abort: () => { this.stop(managed.runId) }`
   (stop() itself guards on status — lever presence is safe for foreground
   runs too). Resolve t01's stop-path verification here if stop needs an
   explicit `markCompleted(id, "aborted")` + `end()`.
3. ext-subagent `subagent-viewer.ts`: rows with `kind === "workflow"` render
   with the badge (already data-driven via badgeText) and the x-key abort
   confirm text says stop for workflow rows (copy: reuse existing confirm;
   minimal change — only if the current copy is subagent-specific).
4. Fix the doc-code drift: registry docstrings in `subagent-in-flight.ts`
   corrected to describe what actually renders (badge + actor, no bespoke
   header).
5. Barrels: no new exports expected beyond `RunView` field additions (types
  flow through existing exports). Run both packages' parity/dead-export gates.

## (c) Tests

- ultracode `tests/workflow-in-flight-registry.test.ts`: `reg.view(wf:id)`
  has `kind === "workflow"` and `abortable === true`;
  `reg.abort(wf:id)` on a deferred background run → run reaches
  stopped/ended (entry gone or `"aborted"`).
- ext-subagent `tests/subagent-viewer.test.ts`: a RunView with
  `kind: "workflow"` renders the `workflow` badge in the Running section; the
  x-key path calls `onAbort` for it like any running row.
- ext-task dock test (where subagents-section is tested): background workflow
  row renders with badge; foreground workflow row absent (foreground filter
  already covered — just the badge assertion is new).
- Regression guard: `renderRunRow` output for a NON-workflow RunView is
  byte-identical to before (snapshot or exact-string assertion) — the badge
  slot must not shift for existing rows.

## (d) Risks / descopes

- `stop()` semantics from the viewer differ from per-child abort (stops the
  whole run) — that IS the workflow analogue; the confirm prompt makes it
  explicit.
- Badge slot contention (detached/background badges vs workflow) — workflow
  kind takes precedence in the single badge slot; documented in RunView.
- Descoped: pause lever from the viewer (p-key), per-agent rows, the reverse
  surface (D3/D4 in map).
- No tool-description changes → schema-cost untouched; verify with
  `bun scripts/check-schema-cost.ts` against the existing baseline.
