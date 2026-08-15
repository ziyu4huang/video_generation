# Subagent dispatch hardening: bounded, salvageable, labeled children (candidate skill)

## Trigger / symptom
Dispatched subagent children (singular `subagent` tool or `subagents` batch) die at their limits and the parent gets nothing back: run records show `"(empty)"` output after a budget abort, whole turns of work are lost uncommitted, or a recon child burns 400-500k tokens exploring and returns zero output. Child status lines and error messages all read `zk-spawn` (a hardcoded label), and after any child death the parent burns turns on archaeology — re-grepping state the child already knew.

## Lesson
- An abort without salvage is a total loss: the child's last assistant text and touched-file list exist in its compact transcript at the moment of death, but nothing surfaced them to the parent — the parent read a bare abort line and started over from zero.
- An all-omitted dispatch is not a "use the defaults" dispatch, it is an UNBOUNDED one: no turn cap at all (tier defaults only bound tokens), so open-ended prompts (recon/explore) can loop indefinitely at ~13k tokens per turn of fixed context overhead.
- Turn economics dominate bounded-task cost: each child turn re-pays ~13k of system prompt + AGENTS/CLAUDE context + tool schemas. One verbatim command block = ~13.5k total; the same work split into 6 command groups = 60-69k. Batch shell work into single blocks per dispatch.
- Labels are diagnostics: a hardcoded label makes every child indistinguishable in status lines, error messages, and watchdog prompts — derive it from the task.
- Aborted writers strand work: a child that edited files but died before reporting leaves a dirty tree the parent must rediscover. Children must write findings to a run-scoped log as they go and report to that log FIRST when near their limits.

## Procedure (dispatch-bounded-subagent)
1. Batch the child's shell work: hand it ONE verbatim command block ("run exactly this, paste capped output, stop") — 1-2 turns. Never split state-gathering into many small command groups (13.5k vs 60-69k observed).
2. Always bound the dispatch: pass explicit `tokenBudget`/`maxTurns`/`timeoutMs`, or rely on the shipped role-aware envelope (all-three-omitted → recon 60k/8 turns/5 min for read-only allowlists, writer 400k/24 turns/20 min when write tools are in the effective allowlist; any explicit bound opts the whole envelope out; `SUBAGENT_TOKEN_BUDGET_DISABLE=1` escapes).
3. For write-capable or long (>10 turns) dispatches, the dispatch layer appends an abort-safety footer (progress log at `/tmp/subagent-runs/<toolCallId>.md`, shell-level `timeout` + orphan kill, report-to-log FIRST at the limits) — write dispatch prompts so the footer's mandates make sense.
4. When a child aborts, read the SALVAGE before re-dispatching: terminal aborts (budget/turns/timedout/user) now surface `files touched:` + `last words:` from the transcript, and the durable run record carries a `salvage` field — prefer a small bounded finisher over starting from scratch.
5. Identify children by their derived label (leading sentence of the task, slugified ≤40 chars); pass an explicit `label` only to pin a stable name across retries.

## Evidence
2026-08-15 incident, 6 failure modes (pre-hardening):
- Budget abort at 461k returning `"(empty)"` to the parent — transcript had the answer, nothing surfaced it.
- Turns abort at 529k with a full turn of work uncommitted (stranded writer; dirty tree salvage needed).
- Unbounded recon dispatches burning 400-500k tokens returning zero output (no turn cap existed; tier defaults bound tokens only).
- Hardcoded `zk-spawn` label on every child status/error line and watchdog prompt — children indistinguishable.
- Stranded writers: aborted children left edited files with no report of what was done.
- Parent archaeology: after each death the parent re-derived child state at ~13k/turn instead of reading salvage.

Post-hardening (this repo, `bun-apps/pi-agent-ext-subagent`): H1 `deriveTaskLabel` (src/spawn-subagent.ts, `label` opt pins), H2 `extractSalvage`/`augmentOutputWithSalvage` + `salvage` on run records (src/subagent-tool-run.ts, src/subagent-tool.ts, src/subagents-tool.ts), H3 `ROLE_AWARE_DISPATCH_BOUNDS`/`roleAwareDefaults` with recon ceiling min(60k, tierDefault) + one-line notice (src/budget-defaults.ts), H4 `shouldInjectFooter`/`abortSafetyFooter` appended to the spawned task only, never the persisted params.task (src/subagent-tool-run.ts). Covered by tests in tests/spawn-subagent.test.ts, tests/budget-defaults.test.ts, tests/subagent-tool-run.test.ts, tests/subagent-tool.test.ts, tests/subagents-tool.test.ts.

## Skill candidate
- **trigger/symptom**: a controller must dispatch a bounded subagent child (implementer, recon, batch) without losing its work or budget to an abort; or an aborted child returned "(empty)"/uncommitted work.
- **lesson**: bounds only when set (all-omitted = unbounded turns); salvage beats re-dispatch; turns ≈13k fixed overhead each — batch shell work; labels must identify the task.
- **proposed procedure**: the 5-step dispatch-bounded-subagent procedure above (batch shell work → bound the envelope → honor the abort-safety footer → salvage before re-dispatch → derive/pin labels).
- **evidence**: the 2026-08-15 6-failure-mode incident + turn-economics measurements above.
- **candidate skill-name**: `bounded-subagent-dispatch`.
