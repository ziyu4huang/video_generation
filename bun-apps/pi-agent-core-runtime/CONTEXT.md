# pi-agent-core-runtime

**RunView** — immutable, per-tick projection of one run's derived presentation state (frozen/live elapsed, unified status, tool-call count, model segment); built only by the registry; renderers never read raw run fields; per-tick ephemeral, never cache. _Source_: src/run-view.ts#RunView

**SubagentInFlightRegistry** — process-local registry of running subagent dispatches; public reads go through view()/views(), writes through start/update*/markCompleted/markFailed/end. _Source_: src/subagent-in-flight.ts#SubagentInFlightRegistry

**ActivityStatus** — the single status vocabulary for all run surfaces: running, queued, and terminal done/error/failed/skipped/timedout/budget/aborted. _Source_: src/agent-row-display.ts#ActivityStatus

**One-hop barrel** — `src/index.ts` re-exports each symbol from the module that DEFINES it; `agent.ts` exports only `CoreAgent` and its option/result types. Pass-through re-exports are what let the barrel keep crediting `agent.js` for definitions that had moved out of it, so a second route into the package is a defect, not a convenience. _Source_: src/index.ts
