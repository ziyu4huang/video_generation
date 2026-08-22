# s2-agent-core-runtime

**RunView** — immutable, per-tick projection of one run's derived presentation state (frozen/live elapsed, unified status, tool-call count, model segment); built only by the registry; renderers never read raw run fields; per-tick ephemeral, never cache. _Source_: src/run-view.ts#RunView
_Avoid_: snapshot, view model (it is a per-tick derived projection with a single builder, not a cacheable state copy)

**SubagentInFlightRegistry** — process-local registry of running subagent dispatches; public reads go through view()/views(), writes through start/update*/markCompleted/markFailed/end. _Source_: src/subagent-in-flight.ts#SubagentInFlightRegistry
_Avoid_: tracker, dispatch table (it is the one registry owning in-flight lifecycle, not a lookup helper)

**ActivityStatus** — the single status vocabulary for all run surfaces: running, queued, and terminal done/error/failed/skipped/timedout/budget/aborted. _Source_: src/agent-row-display.ts#ActivityStatus
_Avoid_: run state, progress enum (it is THE shared vocabulary — no surface may coin its own status words)

**One-hop barrel** — `src/index.ts` re-exports each symbol from the module that DEFINES it; `agent.ts` exports only `CoreAgent` and its option/result types. Pass-through re-exports are what let the barrel keep crediting `agent.js` for definitions that had moved out of it, so a second route into the package is a defect, not a convenience. _Source_: src/index.ts
_Avoid_: index re-export, convenience export (it is the definition-crediting discipline — a second import route is a defect)
