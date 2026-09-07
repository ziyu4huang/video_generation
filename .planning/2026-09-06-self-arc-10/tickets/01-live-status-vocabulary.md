# t01 — live-status vocabulary: `paused` flows through the shared registry

## (a) Verified findings

- `bun-apps/s2-agent-core-runtime/src/agent-row-display.ts:16` — `ActivityStatus`
  union has NO `"paused"`: `queued|running|done|error|failed|skipped|timedout|budget|turns|aborted|detached`.
  Its own docstring claims to be "a superset of workflow's WorkflowAgentStatus"
  — yet `RunStatus` (ultracode `run-persistence.ts`, re-exported through
  `display.ts:5`) includes `paused`.
- `bun-apps/s2-agent-core-runtime/src/run-view.ts` `isTerminalStatus()`:
  terminal ⟺ `status !== "running" && status !== "queued"`. Adding `"paused"`
  naively would mark paused runs terminal (freezes elapsed, no-ops
  `accrueUsage`, evicts from Running sections) — the predicate MUST learn it.
- `bun-apps/s2-agent-ext-ultracode/src/workflow-manager.ts` — `pause()`
  (~:888) sets `managed.status = "paused"` + `emit("paused")` but never touches
  the registry entry; `resume()` (~:903) and `stop()` (~:956) likewise.
  `registerInFlight` (~:784) stamps `status` only once at start (defaults
  `running`); `updateInFlight` (~:800) only refreshes `taskPreview`.
- Registry terminal stamps exist (`markCompleted`/`markFailed`,
  `subagent-in-flight.ts`) but there is NO live-status flip method.

## (b) Implementation steps

1. core-runtime `agent-row-display.ts`: add `"paused"` to `ActivityStatus`;
   `glyphFor` gets a paused glyph (match `runStatusGlyph`'s paused rendering in
   ultracode `display.ts:337` for parity). Exhaustive Records force the map —
   let the compiler list every site.
2. core-runtime `run-view.ts`: `isTerminalStatus` treats `"paused"` as live.
3. core-runtime `subagent-in-flight.ts`: new
   `markLiveStatus(id: string, status: "running" | "queued" | "paused"): boolean`
   — stamps status WITHOUT `endedAt`, fires `invalidate?.()` + `emitChange()`,
   false for unknown id. (Terminal statuses remain markCompleted/markFailed's
   job — enforced by the parameter type.)
4. core-runtime barrel `src/index.ts`: export nothing new if `markLiveStatus`
   is only a method on the exported class (it is — no barrel change expected;
   verify parity gate).
5. ultracode `workflow-manager.ts`:
   - `pause()`: after `managed.status = "paused"` →
     `this.inFlight?.markLiveStatus(workflowInFlightId(runId), "paused")`.
   - `resume()`: VERIFY the path (fog of war): if resume re-enters
     `executeRun`, `registerInFlight`'s `start()` overwrite already restores
     `running` — then no extra call; else `markLiveStatus(…, "running")`.
   - `stop()`: VERIFY whether stop aborts the controller (→ `endInFlight` via
     the executeRun finally, as the abort test at
     `tests/workflow-in-flight-registry.test.ts:248-261` shows for abort). If
     not, add explicit terminal handling in t02 alongside the abort lever.

## (c) Tests

- core-runtime `tests/subagent-in-flight.test.ts` (or the core-runtime test
  home — subagent-in-flight tests live in ext-subagent; place accordingly):
  `markLiveStatus` stamps without `endedAt`, `elapsedFrozen` stays false,
  `accrueUsage` still accrues while paused, `emitChange` fires, unknown id →
  false, `isTerminalStatus("paused") === false`, paused glyph renders.
- ultracode `tests/workflow-in-flight-registry.test.ts`: extend with a
  deferred-agent background run — `manager.pause(runId)` →
  `reg.view(wf:id).status === "paused"`; resume path per verification; pause →
  preview still updates (`updateInFlight` unaffected).

## (d) Risks / descopes

- `"paused"` in ActivityStatus widens a union consumed across four packages —
  run ALL their `bun run check && bun test` (hard gate), rely on exhaustive
  Record/switch compile errors to find missed sites.
- Elapsed ticks while paused (D5) — documented, not fixed here.
- Descoped: per-phase status, paused-duration accounting.
