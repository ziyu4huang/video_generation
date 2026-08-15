---
type: grilling
status: closed
claimed: work-session-2026-07-22
blocked by: [07-full-transcript-tool-arg-capture]  <!-- 07 closed → unblocked -->
---

## Question

What persists per `subagent`-tool run to disk, where, with what retention — for post-session replay (per scope: +disk persistence)?

Open design points:
- **What:** transcript (from ticket 07) + real usage + status + the task prompt + resolved model. Possibly tool-call args/results verbatim.
- **Where:** the workflow package already has an on-disk intermediate system for *workflow* runs (`io.intermediate.persist`, journal = resume source-of-truth, per `CONTEXT.md`). Decide whether subagent-run persistence **reuses that machinery** (extend `run-persistence.ts` to give subagent runs a durable identity) or is a **separate subagent-only store** (e.g. `.pi/subagents/runs/<id>.json`). Reusing avoids a second store; separating keeps subagent-runs decoupled from workflow journaling/resume semantics (a `subagent` call "has no run identity to control" today).
- **Retention:** `all` vs `last-N` (mirror the workflow `io:` retention vocab), and a clean/inspect surface (the package already has a 3-tier `clean` for workflow state — extend or parallel?).
- **Format:** JSON per run vs an append-only log. JSON-per-run is greppable + replayable.

Decide home + schema + retention, and how `/subagents` reads persisted runs when the in-memory + session-branch sources are empty (post-session inspection).

## First takeable step

Extend `run-persistence.ts` (or add `subagent-run-persistence.ts`) with a write-on-completion hook; confirm `/subagents` can list a run from disk after a fresh session.

## Resolution

Persistence layer landed + verified. Six design decisions settled:

1. **Reuse vs separate — SEPARATE store.** A new `src/subagent-run-persistence.ts` (`SubagentRunPersistence`), NOT a reuse of workflow `RunPersistence`. Rationale: workflow persistence is RESUME machinery (journal = replay source-of-truth, cross-process lease, pause/resume, exec caps); a subagent run is a one-shot dispatch with NO resume semantics. Mixing them would muddy the journal's canonical-resume invariant. (Captured as a CONTEXT.md `_Avoid_`.)

2. **Where — `~/.pi/subagents/runs/<id>.json`** (global per-user), mirroring the workflow `~/.pi/workflows` home convention (reuses `homeDir()`). The record carries `cwd` so the viewer can scope by project later. Sibling to `.pi/workflows`, not nested in it.

3. **What persists — `SubagentRunRecord`:** `id`, `toolCallId`, `agent`, full `task` prompt, resolved `model` + requested `tier`, `cwd`, `status`/`exitCode`/`timedOut`/`stderr`, ISO `startedAt`, `elapsedMs`, real `usage`, final `output`, and the **compact `history` transcript** (ticket 07). Everything `/subagents` needs for replay; compact form (per 07), NOT full raw messages.

4. **Format — JSON per run, atomic tmp+rename write.** Write-once at completion (never updated) so no `.bak` is needed (unlike the live-updated workflow state). Greppable + replayable.

5. **Retention — last-N, default 200**, oldest evicted on save. `maxRuns` is injectable on the factory (wiring it to `workflow-settings` is a follow-up; default 200 is sensible for a prototype).

6. **Write hook + `/subagents` read path.** `createSubagentTool` takes an optional `persistence?: SubagentRunPersistence`; `execute` captures the latest `onHistory` snapshot and writes the record on completion (best-effort — `save()` swallows errors so it can NEVER fail the run). Covers `done`/`failed`/`timedout` (spawnSubagent returns a result, never throws); pre-flight `failEarly` paths do NOT persist (not real runs). `extensions/workflow.ts` wires a real instance. The `list()`/`load()` read API is delivered; the `/subagents` viewer "recent (persisted)" section is the designed follow-up (needs UX: global-vs-session presentation) — the API is ready for it.

**Public API:** `createSubagentRunPersistence`, `generateSubagentRunId`, `SubagentRunRecord`/`Persistence`/`Status`/etc. exported from `src/index.ts` (stable). `SubagentRunRecord.history` references `AgentHistoryEntry` (already public).

**Artifact:** `src/subagent-run-persistence.ts` (new), `src/subagent-tool.ts` (persistence hook + lastHistory capture), `extensions/workflow.ts` (wiring), `src/index.ts` (exports), `CONTEXT.md` (`SubagentRunRecord`/`Persistence` entry + `_Avoid_`), `tests/subagent-run-persistence.test.ts` (8 tests) + `tests/subagent-tool.test.ts` (+3 hook tests). Build clean; workflow 1187/0 fail; knowledge-card 377/0 fail.

**Graduated / noted:** the `/subagents` persisted-section UX is now specifiable enough to ticket separately if wanted (the read API exists); the `maxRuns`→settings wiring is a minor follow-up. Neither blocks the destination.
