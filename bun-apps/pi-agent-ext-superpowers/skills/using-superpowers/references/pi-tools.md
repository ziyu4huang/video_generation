# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi these resolve to the tools below.

| Action skills request | Pi equivalent |
| --- | --- |
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use the `subagent` tool provided by `pi-agent-ext-workflow` — `subagent({ task, model, tools, excludeTools, cwd, commitScope })` |
| Dispatch many subagents in parallel (`dispatching-parallel-agents`) | Use the `workflow` tool's `parallel()` — see "Parallel fan-out" below (the `subagent` tool is single-dispatch + sequential) |
| Task tracking ("create a todo", "mark complete") | Use an installed todo/task tool if available, otherwise track tasks in the plan or `TODO.md` |

## Subagents

Pi core does not ship a standard subagent tool. This repo's `pi-agent-ext-workflow` provides a `subagent` tool — a single-agent, isolated-context dispatch (`subagent({ task, model, tools, excludeTools, cwd, commitScope, schema, agentType, timeoutMs, retryOnTransient })`) backed by `spawnSubagent()`. It covers SDD's implementer/reviewer dispatch.

**Single-dispatch + sequential.** The tool declares `executionMode: "sequential"`: if the model emits multiple tool calls in one turn (or a `subagent` call alongside others), pi serializes the whole batch (its rule: any sequential tool call in a turn ⇒ the batch runs serially). This ENFORCES that concurrent fan-out goes through the `workflow` tool (below) — a controller that wants concurrency must use `parallel()`, not ad-hoc multi-dispatch. (Safe for fan-out: the `workflow` tool's `parallel()`/`agent()` dispatch via a SEPARATE `createAgentSession()` path, so the `subagent` tool's sequential declaration does NOT throttle workflow runs.)

**Status contract (automatic).** When a subagent is an SDD implementer, its byte-identical prompt makes it return a prose block starting `**Status:** DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED`. The tool parses this into `details.report` (`SddReport`) — a SEPARATE axis from the process status (`done`/`failed`/`timedout`): a run can finish while self-reporting BLOCKED. The result render badges `SDD:<status>`. No skill action needed; parsing is automatic.

**Persistence (automatic).** Each completed run is written to `~/.pi/subagents/runs/<id>.json` (write-once, last-N=200) — full task prompt, model, status, usage, output, compact transcript — for post-session replay (`/subagents`).

**Commit hygiene (SDD).** When dispatching an SDD implementer or fix subagent, pass `commitScope` with the task's declared file scope — the files/dirs the brief says it may touch, e.g. `subagent({ task, commitScope: ["src/auth/", "tests/auth/"], … })`. The tool records the repo HEAD before dispatch and, after the run, flags any committed path (`git diff base..HEAD`) that falls OUTSIDE that scope as a ⚠ violation in the result + `details.scopeCheck` + the run record — detection only, it never auto-reverts (you decide). This catches the recurring `git add -A` sweep where an implementer stages an untracked scratch file (`.planning/<effort>/sdd/…`, a stray stub) into its commit, which then lands on `main` at squash-merge. Derive the scope from the task brief, not a guess. Use `[]` for a read-only subagent that should commit nothing. Ignored for worktree-isolated runs (their commits are discarded at teardown).

**Public API (peer-extension code).** Dispatching a subagent programmatically from another extension's CODE imports `spawnSubagent` (+ `SpawnSubagentOptions`/`Result`/`AgentUsage`) from `@repo/pi-agent-ext-workflow`, NOT the LLM tool path.

If no `subagent` tool is available, do not fabricate `Task` calls; execute sequentially in the current session or explain that the subagent capability is not installed.

## Parallel fan-out (many subagents)

When a skill calls for dispatching MANY subagents concurrently (e.g. `dispatching-parallel-agents`), use the **`workflow` tool** with its `parallel()` primitive — NOT multiple `subagent` calls (which the sequential declaration above would serialize anyway):

```js
export const meta = { name: "fan_out", description: "..." };
await parallel(items.map((item) => () => agent(`... ${item} ...`, { model: "provider/id" })));
```

`parallel(thunks)` runs the thunks concurrently (bounded 16 live / 1000 total), results in input order. `pipeline(items, ...stages)` is the ordered-chaining counterpart. This is the ONE sanctioned concurrency path; the `subagent` tool stays single-dispatch/serial.

## Task lists

Pi core does not ship a standard task-list tool. If a todo/task extension is installed, use its documented tool. Otherwise use Superpowers plan files, checklists in Markdown, or a repo-local `TODO.md` for task tracking. Older Superpowers docs may refer to `TodoWrite`; treat that as the task-tracking action above.

## SDD workspace & progress ledger

The subagent-driven-development skill and its `sdd-workspace` script reference `.superpowers/sdd/` (task briefs, implementer reports, review packages, and the compaction-recovery progress ledger). On pi this is redirected to the effort layout: `.superpowers/sdd/...` → `.planning/<effort>/sdd/...` — briefs under `briefs/`, reports under `reports/`, review packages under `reviews/`, and the progress ledger at `progress.md`. Derive `<effort>` from the plan you are executing (`.planning/<effort>/plans/<plan>.md`). This override is injected every session via the bootstrap (see `piBoundaryOverrides` rule 3 in `src/superpowers.ts`); it converges the SDD runtime workspace beside the effort's map/tickets/plan without editing the byte-identical skill bodies. **Task brief + review package — inline, not via the scripts.** The byte-identical `task-brief` and `review-package` scripts default their output to `.superpowers/sdd/` and live in the extension's skill dir (a path that only resolves when this monorepo is the working repo). On pi, do NOT call them — run the extraction inline to the effort layout (same "don't call the script, do it directly" philosophy as the workspace override):

- **task brief** — extract Task N's section (fence-aware) to `.planning/<effort>/sdd/briefs/task-<N>-brief.md`:

````bash
awk -v n=N '/^```/{f=!f} !f&&/^#+[ \t]+Task[ \t]+[0-9]+/{t=($0~("^#+[ \t]+Task[ \t]+"n"([^0-9]|$)"))} t{print}' .planning/<effort>/plans/<plan>.md > .planning/<effort>/sdd/briefs/task-N-brief.md
````

- **review package** — commits + stat + diff to `.planning/<effort>/sdd/reviews/review-<base7>..<head7>.diff`:

````bash
{ echo "# Review package: <base>..<head>"; echo; echo "## Commits"; git log --oneline <base>..<head>; echo; echo "## Files changed"; git diff --stat <base>..<head>; echo; echo "## Diff"; git diff -U10 <base>..<head>; } > .planning/<effort>/sdd/reviews/review-<base7>..<head7>.diff
````

Both keep the controller's context lean — the shell writes the file, only the path is handed to the subagent (the child `read`s it). The awk is the byte-identical script's logic inlined (validated BSD-awk-compatible on macOS).

Do NOT call the byte-identical `sdd-workspace` script (it returns `.superpowers/sdd`); use the effort layout directly.
