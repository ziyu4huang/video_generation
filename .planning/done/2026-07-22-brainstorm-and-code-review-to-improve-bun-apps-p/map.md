> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: improve pi-agent-ext-workflow's subagent surface

## Destination

A `subagent` surface in **`bun-apps/pi-agent-ext-workflow/`** that achieves **full claude-code skill parity** for subagent usage, with maximal debug observability and a clean cross-extension programmatic entry:

1. **Parallel fan-out routed through the `workflow` tool's `parallel()`** (capped, journaled); the `subagent` tool stays single-dispatch and its concurrency behaviour is made explicit.
2. **Full SDD parity** — a structured status contract (`DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED`) the controller branches on, a durable (compaction-surviving) progress ledger, and first-class `task-brief` / `review-package` file-handoff helpers that run on Pi.
3. **Maximal debug** — full child transcript + tool-arg capture in `/subagents` and the live trace, **plus disk persistence** of each run for post-session replay.
4. **`spawnSubagent()` stabilized as a documented public API** so peer extensions (`pi-agent-ext-wayfind`, `pi-agent-ext-superpowers`, obsidian/knowledge tools) can invoke subagents from code.

Scope is pinned (see grill decisions, 2026-07-22): parallel → workflow tool; SDD → full parity; debug → +disk persistence; ext → public API.

## Notes

**Domain:** `bun-apps/pi-agent-ext-workflow` — the workflow/subagent engine (thin adapter over the pi SDK; `WorkflowAgent.run` is the LLM caller, `spawnSubagent()` the shared wrapper, the `subagent` tool the LLM-callable single dispatch, `workflow` tool the fan-out engine with `parallel()`/`pipeline()`/`agent()`).

**Target files:** `src/subagent-tool.ts`, `src/spawn-subagent.ts`, `src/agent.ts`, `src/agent-history.ts`, `src/subagent-viewer.ts`, `src/subagent-in-flight.ts`, `src/run-persistence.ts`, `src/index.ts` (public exports), `extensions/workflow.ts`.

**Skills every session should consult:** `superpowers:subagent-driven-development`, `superpowers:dispatching-parallel-agents`, `superpowers:requesting-code-review` (these DEFINE the requirement surface); `wayfinder` (working this map); `domain-modeling` (keep `CONTEXT.md` ubiquitous language current as the surface grows).

**Standing invariants (do not violate):**
- Superpowers skills are **byte-identical to upstream EXCEPT pi-port glue** — only `pi-tools.md` + `references/*` may change; never edit skill bodies. (PR #684 resolution.)
- **Bun only** (never node/npm/yarn). No top-level `cd` (use `( cd … && … )` / `--cwd`).
- This package's CI gate is **`bun run build && bun test` only** — biome drift is explicitly out of scope for CI here.
- The `subagent` tool name is owned by this package; a real `pi-subagents` install would shadow it (the extension already warns).

## Decisions so far

<!-- closed tickets — one-line gist, link for detail -->

- [Survey claude-code subagent skill references](tickets/01-survey-subagent-skill-refs.md) — 7 superpowers skills touch subagent dispatch; the status contract is a prose prefix (`Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`); helpers are `code-reviewer.md` + 3 bash scripts.
- [SDD helper scripts on Pi](tickets/02-sdd-helper-scripts-on-pi.md) — `task-brief`/`review-package`/`sdd-workspace` are `#!/usr/bin/env bash`, use git + stdlib — they run on Pi as-is.
- [Pi concurrent tool execution](tickets/03-pi-concurrent-tool-execution.md) — pi has per-tool `executionMode` (`sequential`/`parallel`), **default is parallel**; a pi-native reference subagent ext already does single/parallel/chain with `MAX_CONCURRENCY=4`. Parallel-via-workflow has solid prior art.
- [Full transcript + tool-arg capture](tickets/07-full-transcript-tool-arg-capture.md) — prototype landed: live trace now shows tool-call args + result previews (≤100 char). Decision: compact form suffices (no new capture field); `/subagents` transcript view for completed runs is deferred to ticket 08 (persistence).
- [Public spawnSubagent API](tickets/09-public-spawnsubagent-api.md) — `spawnSubagent` + `SpawnSubagentOptions`/`Result` + `AgentUsage` are now stable public exports (package root import); knowledge-card migrated off the `./src/*` deep path and verified (377 pass). `SpawnSubagentPrime`/`prime?` stays experimental (③ no-op).
- [Subagent run disk persistence](tickets/08-subagent-run-disk-persistence.md) — new separate `SubagentRunPersistence` (`~/.pi/subagents/runs/<id>.json`, write-once, last-N=200) carrying the full record incl. compact transcript; wired into the `subagent` tool (best-effort) + public exports. Deliberately NOT the workflow journal (different lifecycle).
- [Subagent status contract](tickets/04-subagent-status-contract.md) — SDD report block parsed from the byte-identical prompt's `**Status:**` prefix into `details.report?: SddReport` (separate axis from process status); full block (status reliable, rest best-effort), badged in render, persisted, publicly exported.
- [Durable progress ledger](tickets/05-durable-progress-ledger.md) — decision: redirect the SDD workspace+ledger to `.planning/<effort>/sdd/` (not byte-identical `.superpowers/sdd/`); append-only .md, task-keyed, complement to 08's dispatch-keyed store. **IMPLEMENTED in superpowers** via `piBoundaryOverrides` rule 3 (auto-injected bootstrap override, ADR-0004-safe) + pi-tools.md; satisfies ticket 11's ledger scope.
- [File-handoff helpers](tickets/06-file-handoff-helpers.md) — decision: **A' inline bash**. The controller does NOT call `task-brief`/`review-package` either (script-path resolution is fragile across projects); it runs the verbatim fence-aware awk (task extraction) + `git diff` (review package) inline to files under `.planning/<effort>/sdd/briefs|reviews/`, documented in pi-tools.md — consistent with rule 3's philosophy. sdd-workspace retired (rule 3). Zero new code; impl absorbed by ticket 11. BSD-awk-compatible (validated).
- [executionMode declaration](tickets/10-subagent-executionmode-declaration.md) — `subagent` tool declares `executionMode: "sequential"`; enforces "parallel via workflow" at the engine level (any sequential call ⇒ batch serializes, agent-loop.js:289). SAFE for fan-out: workflow.parallel() dispatches via a separate `createAgentSession()` path (agent.ts:422), unaffected. Implemented (one line + CONTEXT.md + test assertion).
- [pi-tools.md glue](tickets/11-update-pi-tools-and-skill-glue.md) — IMPLEMENTED: pi-tools.md consolidated all closed gaps (parallel routing, sequential executionMode, status contract, persistence, public API, inline handoff). references/* glue only; skill bodies byte-identical (fidelity guard green, 115/0).

**All 11 tickets closed — destination reached** (parallel via workflow; full SDD parity; maximal debug + disk persistence; public spawnSubagent API). The remaining "Not yet specified" items are genuine future-effort frontier, not gaps in this effort.

## Not yet specified

<!-- fog toward the destination — in scope, not yet sharp enough to ticket -->

- **Status contract surface in `workflow`'s `agent()` too?** The structured status is being designed for the `subagent` tool; whether `agent()` inside workflow scripts should return the same shape (for consistency) surfaces after the status-contract ticket (04) resolves.
- **Disk persistence vs the workflow journal.** The engine already has an on-disk intermediate system (`io.intermediate.persist`, journal = resume source-of-truth). Whether subagent-run persistence reuses that or is a separate subagent-only store surfaces after the persistence ticket (08) resolves.
- **Testing strategy for the new surfaces.** `writing-skills`' testing-skills-with-subagents methodology (pressure scenarios) applies to the new contracts; the concrete test plan surfaces after the design tickets close.
- **`subagent` ↔ `pi-subagents` coexistence.** If a user installs the pi-native parallel/chain subagent ext alongside this package, both own `subagent`. Whether to document the choice or add a handoff surfaces only if it bites.

## Out of scope

<!-- ruled past the destination — never graduates -->

- Rewriting superpowers skill **bodies** — byte-identical invariant; only `pi-tools.md` + `references/*` glue changes (see ticket 11).
- Reimplementing pi's agent engine / provider / auth layer — `WorkflowAgent` is a thin adapter over `createAgentSession`; it owns no fetch/provider SDK.
- Adding concurrent multi-dispatch **into the `subagent` tool itself** — parallel fan-out is routed through the `workflow` tool's `parallel()` per the pinned scope decision.
- Adding new LLM providers or model transports.
- Migrating `zk_card`/`zk_ask` off `spawnSubagent` — already migrated; this effort only stabilizes the API surface, not the callers.
