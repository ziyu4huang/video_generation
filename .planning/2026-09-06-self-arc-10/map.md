---
effort: 2026-09-06-self-arc-10
created: 2026-09-07
last: 2026-09-07
status: done
---

# Wayfinder map: 2026-09-06-self-arc-10 — unified agents surface

## Destination

One lifecycle vocabulary and one set of levers for the subagent family and the
ultracode workflow family: a workflow run is a first-class row on the shared
surfaces (/subagents viewer, above-editor dock) with a live status that tracks
pause/resume/stop, an abort lever that actually stops it, and an explicit
`workflow` label. No engine merge — the shared `SubagentInFlightRegistry`
already is the seam; this arc finishes its workflow half.

## Context

Measured 2026-09-07 by the hard-problem planner (all file:symbol read in-tree):

- Stage B (decision 03 = b2) ALREADY registers workflow runs into the shared
  registry: `workflow-manager.ts` `registerInFlight`/`updateInFlight`/`endInFlight`
  + `setInFlight`, wired in `extensions/ultracode.ts:140`; contract-tested in
  `tests/workflow-in-flight-registry.test.ts`.
- What did NOT land: (1) `pause()`/`resume()`/`stop()` (~workflow-manager.ts:888/903/956)
  never touch the registry entry — a paused workflow still reads `running`;
  (2) `registerInFlight` passes no `abort` lever, so the viewer's x-key is a
  silent no-op on `wf:` rows (`RunView.abortable` false); (3) `ActivityStatus`
  (agent-row-display.ts:16) has no `"paused"` member; (4) `subagent-viewer.ts`
  and `subagent-tool-render.ts` have zero workflow awareness (grep: no hits) —
  the registry docstrings promise a "workflow-specific header" that does not
  exist (doc-code drift).
- Receipt machinery exists: `bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts`
  `--scenario` (self-arc-9's `swarm` is the pattern; run dirs under `output/`).

## Tickets

- [ ] t01 — live-status vocabulary: `paused` flows through the shared registry (core-runtime + ultracode)
- [ ] t02 — workflow rows labeled + abortable on the shared surfaces (core-runtime + ultracode + subagent + task)
- [ ] t03 — `--scenario workflow` receipt, source + deployed legs

## Decisions

- D1: Ship shape ≈ candidate 3 of the dispatch ("workflow side already wired —
  finish it"), scoped to status/levers/labels. Rationale: the bridge exists and
  is tested; the honest gaps are exactly those three.
- D2: NO shared `LiveRunSource` interface type this arc. The concrete
  `SubagentInFlightRegistry` IS the shared source both families already import;
  an interface over one implementation is ceremony. Revisit only if a third
  family appears.
- D3: Reverse surface (workflow task panel showing subagent rows) is DESCOPED —
  the workflow panel is workflow-owned and event-driven off `WorkflowManager`;
  the shared surfaces are the dock + /subagents.
- D4: Workflow agent-level rows (per-child) in /subagents are DESCOPED —
  run-level rows with `k/N` preview only.
- D5: Elapsed keeps ticking while paused (`now - startedAt`). Smallest honest
  behavior; revisit if it reads wrong live.

## Frontier

t01 first — it is the vocabulary every other ticket renders, and its
`isTerminalStatus` change is the riskiest compile-wide edit.

## Fog of war

- Whether `resume()` re-enters `executeRun` (and thus re-registers via
  `registerInFlight`) or revives the existing entry — t01 verifies before
  coding the resume path.
- Whether `stop()` aborts the controller (→ `endInFlight` via finally) or
  leaves the entry needing an explicit end — t01 verifies.
- `tui-drive.ts` scenario table shape (stub-model scripting) — t03 reads the
  `scenarioSwarm` implementation before extending.

## Cross-effort links

- Builds-on: `2026-09-06-self-arc-7` (onChange channel + F-invalidate), `2026-09-06-self-arc-9` (abortBatch, swarm scenario, gesture/child-evidence discipline).

Back-link: self-arc-12 (cc-parity samples) reused the workflow receipt harness (B-suite drives real WorkflowManager) — see `.planning/2026-09-06-self-arc-12/map.md`.

## Shipped-as (close-out)

PR #2202 merged CLEAN on the second attempt (squash `6628775`): the first
attempt bounced on (a) a real TS2322 downstream of the modelSeg-optional
change (the follow header interpolated `r.modelSeg` into a `string` local —
fixed by making the segment conditional), and (b) the deploy e2e's
glm-5.3-flash roundtrip hitting its 90s cap (exit 137 = killed by the cap —
environmental latency, passed on immediate re-run; discrimination per the
runbook's environmental-red rule). Main synced; redeployed `0.10.0+g6628775`.

## FULL pipeline qualification (deployed tree, 2026-09-07)

All eight tui-drive scenarios PASS on `0.10.0+g6628775`, run as three
concurrent batches (receipts under `output/qual-*/`):

| scenario | pass | snaps | failed checks |
|----------|------|-------|----------------|
| dispatch | ✓ | 26 | none |
| parallel | ✓ | 24 | none |
| viewer   | ✓ | 10 | none |
| agents   | ✓ | 10 | none |
| reload   | ✓ | 20 | none |
| catalog  | ✓ | 6  | none |
| swarm    | ✓ | 10 | none |
| workflow | ✓ | 30 | none |
