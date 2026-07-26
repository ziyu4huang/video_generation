---
type: task
status: in progress (slice 1 done; §4 telemetry = slice 2)
---

# 04 — shared subprocess-wrapper

## Slice 1 — DONE

`spawnSubagentSubprocess(opts)` implemented in
`pi-agent-ext-subagent/src/spawn-subagent-subprocess.ts` (+ exported from the
package index). Core runner + §2 + §3, fully TDD'd with an injectable `spawnFn`
(class-based mock child):

- **§2** model resolved from config (`loadModelTierConfig` + `resolveModelRole`; precedence model > capability > tier > mainModel) → child `--model`. No hardcodes.
- **§3** retry-once-on-transient (`isTransientError`) + `timeoutMs` (default 5 min; SIGTERM → 5s grace → SIGKILL) + `externalSignal` cancel.
- Generalized pure helpers exported for 05/06 to reuse: `getPiInvocation`, `buildSubagentArgs`, `isTransientError`.
- Return shape mirrors `SpawnSubagentResult` (drop-in alternative to `spawnSubagent`).
- **16 tests green** (pure helpers + runner success/retry/timeout/signal/system-prompt/onEvent/spawn-error); tsc clean; full suite 290/0.

## Slice 2 — pending (§4 phantom telemetry)

Register a host-side **phantom entry** in the in-flight registry +
run-persistence on spawn, mark done on child exit → visible to `/subagents`.
Mirrors the registration the subagent TOOL layer does around `spawnSubagent`.

## Question

Build the §1 vehicle: a shared wrapper in `pi-agent-ext-subagent` that dispatches
a subagent as a child pi process WHILE providing the contract guarantees
(§2 config-aware, §3 retry/timeout, §4 phantom telemetry). Used by obsidian (05)
+ tool-gate (06).

## What resolving it looks like

A `spawnSubagentSubprocess(opts)` (or similar) in the subagent package that:

- spawns `bun pi-agent/cli.ts` (one-shot `-p` mode) as a child process (preserving
  the isolation obsidian/tool-gate depend on);
- **§2**: resolves the model from `tiers`/`capabilities` config (passes `--model`
  from config, NOT hardcoded) — or lets the spawned pi read config itself
  (default); accepts a caller tool-allowlist;
- **§3**: wraps the child in `retryOnTransient` + a default `timeoutMs` (kills the
  child on timeout);
- **§4**: registers a host-side **phantom entry** in the in-flight registry +
  run-persistence on spawn, marks done on child exit (visible to `/subagents`;
  granular inner activity is best-effort).

Extraction target: the shared bits of obsidian's `lib/subagent.ts` (temp-script +
curated-tools + spawn) generalized + wrapped with the guarantees.

## blocked by

(none — keystone build ticket)

## Skills

`test-driven-development` (wrapper is pure logic + testable without a real pi
child); `systematic-debugging` if a consumer breaks after routing through it.
