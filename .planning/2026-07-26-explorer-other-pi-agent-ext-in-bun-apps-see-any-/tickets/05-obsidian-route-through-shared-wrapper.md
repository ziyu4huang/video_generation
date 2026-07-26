---
type: task
status: in progress (slice 1 done: routing wired; slice 2: delete dead code + test file)
blocked by: 04
---

# 05 — obsidian → shared wrapper

## Slice 1 — DONE

Both distill + garden call sites now route through `runObsidianSubagent` (a thin
adapter in `lib/subagent.ts`) → `spawnSubagentSubprocess`. The adapter resolves
the model via obsidian's existing policy (`resolveSubagentModel`: OB_ env floor +
refuse-weak-parent) + passes it to the wrapper, then parses the child's
`pi_obsidian_result` (`parseStructuredResult` — wrapper returns raw text). §4
phantom telemetry wired (passes the singletons).

- `obsidian/package.json`: +`@repo/pi-agent-ext-subagent` dep.
- `obsidian/src/lib/subagent.ts`: +adapter +import; 2 call sites switched.
- `subagent/src/sdd-report.ts`: strict-null fix (pre-existing bug surfaced by
  obsidian's strict tsconfig cross-checking subagent src — `statusMatch[1]` /
  `m[1]` under `noUncheckedIndexedAccess`).
- obsidian typecheck clean; obsidian tests 399/0; subagent 295/0, check EXIT=0.

The old generic functions (`runSubagent`, `runSubagentWithRetry[Impl]`,
`getPiInvocation`, `buildSubagentArgs`, `isTransientError`) are now UNUSED by
obsidian.ts but still exported + tested — **slice 2** deletes them + the
`subagent-args.test.ts` file.

Live end-to-end (real distill/garden subprocess via the wrapper) is a manual
smoke test (the wrapper itself is mock-tested, 295 tests).

## Slice 2 — pending (dead-code cleanup)

Delete from `lib/subagent.ts`: `runSubagent`, `runSubagentWithRetry`,
`runSubagentWithRetryImpl`, `getPiInvocation`, `buildSubagentArgs`,
`isTransientError` (+ their now-unused node: imports). Delete
`extensions/__tests__/subagent-args.test.ts` (only tested the deleted
`buildSubagentArgs`).

## Question

Replace obsidian's `src/lib/subagent.ts` raw `child_process.spawn` with a call to
the shared subprocess-wrapper (04). Preserves isolation (still subprocess) + gains
§2–§4 (config-aware, retry/timeout, telemetry visibility).

## What resolving it looks like

- obsidian's distill/garden paths call `spawnSubagentSubprocess` instead of the
  in-package `spawn`;
- the curated-tool-allowlist + temp-script logic moves to caller args of the
  wrapper (or stays in obsidian as pre-processing);
- verify distill/garden still run + now appear in `/subagents`.

## blocked by

04 (shared subprocess-wrapper)
