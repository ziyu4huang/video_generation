---
type: research
blocked by: []
status: closed
resolved: 2026-07-31 (5 robustness candidates consolidated; 0 net-new discovery)
---

# 02 — Known-issue robustness consolidation (subagent + workflow)

## Question

What **robustness** candidates are already half-known for these two extensions?
Consolidate — do NOT re-discover.

## Resolution (researched 2026-07-31, branch behind:0)

**Method / sources read.** 6 `.planning` effort dirs (`spawn-pi-enoent`,
`subagent-tui-review`, `subagents-viewer-redesign`, both `self-reflection-*`,
`known-issues-disposition`) — maps + tickets; code greps for
`TODO/FIXME/XXX/HACK/@deprecated` + `best-effort/silently/degrade/fallback` across
both `src/` trees; full read of `watchdog/`, both spawn wrappers, `errors.ts`,
`subagent-in-flight.ts`, `subagent-run-persistence.ts`, `agent.ts`; open
`gh issue list` (#831/#853/#854). **No internet. No net-new discovery.**

### Candidates (axis: `robustness`)

1. **Cross-extension singleton sharing for in-flight + run-persistence** (viewer
   visibility of subprocess-spawned runs). Symptom: `/subagents` "Running" +
   completed entries for subprocess-spawned runs (obsidian distill/garden via
   `runObsidianSubagent`→`spawnSubagentSubprocess`) depend on BOTH extensions
   resolving the **same module instance** of `getSubagentInFlightRegistry()` /
   `getSubagentRunPersistence()`. If module identity diverges (2nd `node_modules`
   copy, bundler, symlink hop, future pi loader change) the subprocess registers
   its phantom entry in one instance while the viewer reads another → **runs
   silently invisible**. Root-cause: **confirmed** — coupling is module-identity
   convention only, mechanically unenforced. Shape: module-instance identity
   handshake that loud-warns on divergence. Provenance: code grep; contextual to
   `2026-07-30-spawn-pi-enoent-*` (the §4 telemetry residual PR #949 left).
2. **Watchdog L1/L2 silently no-op when prerequisites absent.** Symptom: a
   `watchdog:true` dispatch still reports success when both layers degrade — L1
   `ran:false` if `typescript-language-server` isn't on PATH
   (`lsp-diagnostics.ts:561`), L2 `ran:false` with `note:"review-skipped"` when
   `model-tiers.json` has no `review`/`big` (`model-review.ts:48`); `watchdog.ts`
   summary only appends "L1+L2 degraded" — easy to miss in a passing run →
   **false sense of "reviewed"**. Root-cause: **confirmed** (graceful degradation
   by design; no-op visibility is the gap). Shape: when a dispatch REQUESTED
   watchdog but zero layers ran, surface a hard ⚠ sentinel in the tool result.
3. **Watchdog L1 changed-set over-inclusive in a pre-dirty tree.** Symptom: L1
   derives its LSP check-set from POST-spawn `git status`, "over-inclusive of
   pre-dirty in a dirty tree; exact when clean — the SDD target case"
   (`repo-diff.ts` comment). An already-dirty worktree → L1 re-lints files the
   subagent never touched → spurious blockers/noise. The runner already computes
   a precise `before` baseline (`runWatchdog` gets `input.before`). Root-cause:
   **confirmed** (documented limitation). Shape: feed L1 the precise
   `before→after` delta instead of post-only paths.
4. **Abort/timeout classification relies on error-text substring matching.**
   Symptom: `classifyError()` (`spawn-subagent.ts:150`) and
   `isAbortError()`/`isTimeoutError()` (`errors.ts`) classify by regex on
   `Error.name`/`.message` BECAUSE the runtime surfaces aborts as plain
   `Error("Subagent was aborted")` (name `"Error"`), not a `DOMException`
   `AbortError` (`spawn-subagent.ts:152` comment). If the SDK ever changes that
   wording, aborts misclassify as non-transient → a cancelled run could be
   RETRIED, or a timeout conflated with a generic error. Root-cause: **suspected**
   (inconsistency real & in-code-flagged; brittleness is to future SDK drift).
   Shape: thread the abort REASON (controller state) as authoritative everywhere,
   drop the message-substring fallback.
5. **Relative-time labels go stale on idle `/subagents` completed list**
   *(borderline UX/robustness — weakest).* Symptom: "5m ago" timestamps only
   refresh on next keypress — deliberate avoidance of re-rendering the static list
   every second. Documented as deferred: `2026-07-30-subagents-viewer-redesign/
   spec.md` ("Live-renders for filter staleness" + Out-of-Scope "periodic refresh
   of the static completed list"). Root-cause: **confirmed** (deliberate
   trade-off). Shape: periodic (~60s) refresh of the static completed list only.

### Already closed elsewhere (excluded — do not re-open)

- **`spawn("pi")` ENOENT (PR #949, MERGED).** The one repo subprocess call site
  (`pi-agent-ext-obsidian/src/lib/subagent.ts`) now uses shared
  `spawnSubagentSubprocess` with `resolvePiInvocation` self-resolve + loud throw
  (`spawn-subagent-subprocess.ts:55–86`). **No ENOENT gap remains there.** (The
  residual IS candidate #1 — telemetry-sharing seam, a different concern.)
- **Test-hermeticity cluster** (watchdog #937 / hermes #938 / workflow
  `loadConfig`) — closed in `2026-07-30-self-reflection-to-fix-these-error` 01.
- **RCA#6 unknown-tier silent escalation** — now `console.warn` + `onModelFallback`
  (`agent.ts:165`).
- **Provider-limit misclassification (`\bquota\b`/`\bbilling\b`)** — removed
  (`errors.ts:89`).
- **Workflow model-fallback silent degrade** — surfaced via `onModelFallback`
  (`workflow.ts:534`).
- **Resume-cap silent reset** — `PersistedExecOptions` captured at start
  (`run-persistence.ts:30`).
- **`known-issues-disposition` 5 items** — all obsidian-only, no spill-over.
- **Open gh issues #853/#854** (hermes consolidation), **#831** (subagent-TUI
  migration-hygiene branch) — none are robustness bugs.

**Note for 04:** All 5 candidates live predominantly in `pi-agent-ext-subagent`
(the workflow engine core resides there post-extraction); `pi-agent-ext-workflow`
contributed **no open** robustness seams. #1 = highest confidence/leverage; #5 =
weakest (display staleness, most defensible to defer).
