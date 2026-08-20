# Resume Robustness — movie-director `/produce-video` crash→resume (Layer B)

**Date:** 2026-07-12
**Plan:** `.planning/movie-workflow-resume/`
**Status:** ⏳ **PENDING — Layer B real-GPU run deferred.** Layer A (the permanent,
deterministic, CI-able proof) is DONE and committed (`src/resume.test.ts`:
`recoverStaleRuns` + real-journal-prefix replay that deep-equals a clean run).
This receipt is the real-world GPU kill→resume confirmation. Fill the tables
below after running the repro.

## What this proves

A `/produce-video` run killed mid-assets (the 2026-07-12 kernel-panic class)
leaves a durable journal on disk; on the next session `WorkflowManager`
auto-detects the dead run (`running` → `paused`) and `/workflows resume <runId>`
replays the completed prefix (zero re-cost) and finishes only the remaining
work — yielding the same published artifact as a clean run.

## Prerequisites

```bash
# keep workflow dist in sync with src after any workflow src change
( cd bun-apps/s2-agent-ext-workflow && bun run build )
```

## Reproduce

**Terminal 1 — start the run:**
```bash
bun bun-apps/s2-agent/src/cli.ts \
  -e bun-apps/s2-agent-ext-movie-director \
  -e bun-apps/s2-agent-ext-workflow \
  -p "/produce-video concept='a 15s animated explainer about how tides work'"
```
Note the `runId` printed when the run starts (also visible in `/workflows`).

**Terminal 2 — `kill -9` mid-assets (the documented crash window):**
Watch the phase log; once it enters **scene-assets** (T2I/I2V generating — the
GPU-heavy window where the 2026-07-12 panics struck), kill HARD:
```bash
pgrep -f "s2-agent/src/cli.ts" | head -1 | xargs kill -9
```
Confirm the process is gone with no graceful cleanup (the point — simulates a
panic/power loss; the persisted run stays `status:"running"`).

**Terminal 3 — restart + resume:**
```bash
bun bun-apps/s2-agent/src/cli.ts \
  -e bun-apps/s2-agent-ext-movie-director \
  -e bun-apps/s2-agent-ext-workflow \
  -p "/workflows resume <runId-from-terminal-1>"
```
On startup, `recoverStaleRuns` must have already flipped the dead `running` run
to `paused` (visible in `/workflows` as resumable). `/workflows resume` then
replays the finished prefix + runs only the rest.

## Capture checklist (fill after running)

| Evidence | Value |
|----------|-------|
| runId | _ |
| Crash point (phase / step) | _ |
| Journal entries cached before crash (`createRunPersistence(cwd).load(runId).journal.length`) | _ |
| `recoverStaleRuns` auto-flipped `running`→`paused` on restart? (y/n) | _ |
| Resumed run token/$ delta ≈ remaining work only, NOT a full re-run? (y/n + numbers) | _ |
| Final published artifact valid (`movie.final-review` / schema / plays uncorrupt)? (y/n) | _ |
| Artifact equivalent to a clean run at the crash seam (no truncation/corruption)? (y/n) | _ |

## Result

_(to write after the run; if resume revealed a real bug, record it in
`.planning/movie-workflow-resume/findings.md` "Issues Encountered" and fix under
a new phase before claiming success.)_

## Reference

- Layer A permanent proof: `bun-apps/s2-agent-ext-movie-director/src/resume.test.ts`
- Wiring: `src/movie-manager.ts` (`createMovieManager`) + `extensions/movie-workflows.ts` (handler → `mgr.runSync`)
- Resume internals: `bun-apps/s2-agent-ext-workflow/src/{workflow-manager,call-global,run-persistence}.ts`
- Predecessor (the integration this hardens): `receipts/workflow-redesign-20260712.md`
