# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi these resolve to the tools below.

> Renamed 2026-08-20 (see the `extension-naming` skill, `bun-apps/s2-agent-ext-devops/skills/extension-naming/SKILL.md`): `subagent` → `spawn_subagent`, `subagents` → `list_subagents`, `subagent_runs` → `list_subagent_runs`, `workflow` → `run_workflow`. Historical transcripts referencing the old names mean the same tools.

| Action skills request | Pi equivalent |
| --- | --- |
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use the `spawn_subagent` tool provided by `s2-agent-ext-subagent` — `spawn_subagent({ task, model?, capability?, tier?, tools?, excludeTools?, cwd?, commitScope?, tokenBudget?, spendBudget?, timeoutMs?, schema?, agentType?, watchdog? })` |
| Dispatch many subagents in parallel (`dispatching-parallel-agents`) | Use the `run_workflow` tool's `parallel()` — see "Parallel fan-out" below (the `spawn_subagent` tool is single-dispatch + sequential) |
| Task tracking ("create a todo", "mark complete") | Use an installed todo/task tool if available, otherwise track tasks in the plan or `TODO.md` |

## Subagents

Pi core does not ship a standard subagent tool. This repo's `s2-agent-ext-subagent` provides a `spawn_subagent` tool — a single-agent, isolated-context dispatch (`spawn_subagent({ task, model?, capability?, tier?, tools?, excludeTools?, cwd?, commitScope?, tokenBudget?, spendBudget?, timeoutMs?, schema?, schemaRepairAttempts?, agentType?, retryOnTransient?, watchdog? })`) backed by `spawnSubagent()`. It covers SDD's implementer/reviewer dispatch. (This is the LLM tool path. superpowers consumes it that way — it does NOT import `spawnSubagent` in code; see the "Public API" note below for the programmatic path other peer extensions use.)

**Single-dispatch + sequential.** The tool declares `executionMode: "sequential"`: if the model emits multiple tool calls in one turn (or a `spawn_subagent` call alongside others), pi serializes the whole batch (its rule: any sequential tool call in a turn ⇒ the batch runs serially). This ENFORCES that concurrent fan-out goes through the `run_workflow` tool (below) — a controller that wants concurrency must use `parallel()`, not ad-hoc multi-dispatch. (Safe for fan-out: the `run_workflow` tool's `parallel()`/`agent()` dispatch via a SEPARATE `createAgentSession()` path, so the `spawn_subagent` tool's sequential declaration does NOT throttle workflow runs.)

**Status contract (automatic).** When a subagent is an SDD implementer, its byte-identical prompt makes it return a prose block starting `**Status:** DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED`. The tool parses this into `details.report` (`SddReport`) — a SEPARATE axis from the process status (`done`/`failed`/`timedout`): a run can finish while self-reporting BLOCKED. The result render badges `SDD:<status>`. No skill action needed; parsing is automatic.

**Persistence (automatic).** Each completed run is written to `~/.pi/subagents/runs/<id>.json` (write-once, last-N=200) — full task prompt, model, status, usage, output, compact transcript — for post-session replay (`/subagents`).

**Commit hygiene (SDD).** When dispatching an SDD implementer or fix subagent, pass `commitScope` with the task's declared file scope — the files/dirs the brief says it may touch, e.g. `spawn_subagent({ task, commitScope: ["src/auth/", "tests/auth/"], … })`. The tool records the repo HEAD before dispatch and, after the run, flags any committed path (`git diff base..HEAD`) that falls OUTSIDE that scope as a ⚠ violation in the result + `details.scopeCheck` + the run record — detection only, it never auto-reverts (you decide). This catches the recurring `git add -A` sweep where an implementer stages an untracked scratch file (`.planning/<effort>/sdd/…`, a stray stub) into its commit, which then lands on `main` at squash-merge. Derive the scope from the task brief, not a guess. Use `[]` for a read-only subagent that should commit nothing. Ignored for worktree-isolated runs (their commits are discarded at teardown).

**Budget (SDD).** When dispatching an SDD implementer or reviewer that is expensive or open-ended (exploratory research, a large multi-file refactor, an agent with a generous `timeoutMs`), consider passing `tokenBudget` (and/or `spendBudget`) to bound runaway spend — the run aborts mid-run with status `budget` (`details.budget: {kind,limit,actual}`) if exceeded, distinct from `timedout`. This is **soft guidance, not mandatory** (unlike `commitScope`, there is no known recurring SDD token-runaway failure): a well-scoped implementer on a known codebase rarely needs it. Pairs naturally with `timeoutMs` (wall-clock) — budget catches a *looping* agent that wall-clock alone cannot.

**Timeout (default).** Omitting `timeoutMs` no longer means "no timeout" — it falls back to `DEFAULT_TIMEOUT_MS` (15 min). Safety net: in-process children are synchronous to the parent turn, so a child that deadlocks / hangs on a network call / loops without burning tokens (`tokenBudget` can't catch that) would otherwise block the whole interactive session indefinitely. Legit runs rarely exceed ~10 min, so 15 min almost never false-kills; pass an explicit `timeoutMs` for known-long tasks.

**Watchdog (SDD).** When dispatching an SDD implementer or fix subagent, pass `watchdog:{l2:true}` — a post-spawn adversarial review of the child's changes. L1 is a local `typescript-language-server` scan over the changed TS/JS files (free, zero tokens): errors → blocker, warnings → concern. L2 (opt-in via `l2:true`) dispatches a read-only model-review subagent (resolved via `resolveModelRole({capability:"review"})`, falling back to the `big` tier) that returns structured findings (`{severity,file,finding}`). Findings are **advisory only** — surfaced in the run record (`details.watchdog`) and a summary line on the result, never block or fail the run. It is **edit-gated**: if the child committed nothing, both layers skip (a no-op for reviewers/research). `true` enables L1 only; `{l2:true}` enables L1+L2. Use `{l2:true}` for implementer/fix dispatches (the recurring "commits only the test file" failure is exactly what L2 catches); omit it for non-editing dispatches.

**Model selection — prefer `tier` over raw `model`.** The tool's schema explicitly recommends `tier` over a concrete `model` id: `tier` resolves to the user's model-tiers config (`~/.pi/workflows/model-tiers.json`, editable via `/workflows-models`) and is portable across users/machines, whereas a raw `model` id (e.g. `openai/gpt-4.1-mini`) is user-specific and breaks if that provider isn't configured. Override priority when more than one is set: `model` > `tier` > the session's current model (omit both to inherit the session model). SDD role→tier convention: implementer = `medium`, focused research/exploration = `small`, synthesis / final-review = `big`. Pass `tier` where the byte-identical implementer-prompt's `model:` field asks for a model.

**Structured output (`schema`).** Pass a JSON Schema as `schema` and the child must return via a `structured_output` call matching it; the tool result is the JSON-serialized object (not prose). Use it when the controller will branch on fields — e.g. an SDD task reviewer returning structured `{severity, file, finding}` findings, or a research dispatch returning a fixed shape. `schemaRepairAttempts` (default 2) controls in-session repair re-prompts when the child emits prose instead; bump it for models that unreliably emit structured output.

**Named agent profiles (`agentType`).** `agentType` names a definition file (`.pi/agents/<name>.md` or `~/.pi/agents/<name>.md`) that binds tools/model/prompt and optionally requests worktree isolation. An explicit `model`/`tier`/`tools`/`excludeTools` on the call overrides the binding's values. Use it to dispatch a reusable role (a read-only explorer, a hardened reviewer) without restating its config every time.

**Public API (peer-extension code).** Dispatching a subagent programmatically from another extension's CODE imports `spawnSubagent` (+ `SpawnSubagentOptions`/`Result`/`AgentUsage`) from `@repo/s2-agent-ext-subagent`, NOT the LLM tool path. (superpowers itself does NOT use this path — it drives subagents via the `spawn_subagent` tool call; this note is for peer extensions like `knowledge-card`/`wayfind` that need programmatic dispatch. Only the two singletons demand the `@repo/s2-agent-ext-subagent/src/*` subpath — see that package's README + ADR-subagent-0001.)

**Process isolation (subprocess runner).** When a caller needs a CLEAN pi process (separate cwd, crash isolation, no shared in-process state) — not just an isolated *context* — use `spawnSubagentSubprocess`: the subprocess analog of `spawnSubagent`, same return shape + same contract guarantees (config-only model, retry/timeout, opt-in telemetry). Import from `@repo/s2-agent-ext-subagent/src/spawn-subagent-subprocess.ts` (the `.ts` subpath — a root `@repo/...` import pulls the full agent graph + adds ~8s to CLI boot; see ADR-subagent-0001). obsidian's Zettelkasten distill/garden route through it. Default to the in-process `spawnSubagent`; reach for the subprocess wrapper only when process-level isolation is load-bearing.

If no `spawn_subagent` tool is available, do not fabricate `Task` calls; execute sequentially in the current session or explain that the subagent capability is not installed.

## Parallel fan-out (many subagents)

When a skill calls for dispatching MANY subagents concurrently (e.g. `dispatching-parallel-agents`), use the **`run_workflow` tool** with its `parallel()` primitive — NOT multiple `spawn_subagent` calls (which the sequential declaration above would serialize anyway):

```js
export const meta = { name: "fan_out", description: "..." };
await parallel(items.map((item) => () => agent(`... ${item} ...`, { model: "provider/id" })));
```

`parallel(thunks)` runs the thunks concurrently (bounded 16 live / 1000 total), results in input order. `pipeline(items, ...stages)` is the ordered-chaining counterpart. This is the ONE sanctioned concurrency path; the `spawn_subagent` tool stays single-dispatch/serial.

## Task lists

Pi core does not ship a standard task-list tool. If a todo/task extension is installed, use its documented tool. Otherwise use Superpowers plan files, checklists in Markdown, or a repo-local `TODO.md` for task tracking. Older Superpowers docs may refer to `TodoWrite`; treat that as the task-tracking action above.

## SDD workspace & progress ledger

The subagent-driven-development skill and its helper scripts (`sdd-workspace`, `task-brief`, `review-package`) are effort-aware on pi: set `PI_PLANNING_EFFORT=<effort>` and they resolve under `.planning/<effort>/sdd/` (briefs under `briefs/`, reports under `reports/`, review packages under `reviews/`, progress ledger at `progress.md`). Derive `<effort>` from the plan you are executing (`.planning/<effort>/plans/<plan>.md`). This converges the SDD workspace beside the effort's map/tickets/plan; with no effort the scripts fall back to flat `.planning/sdd/` (gitignored, local-only). You may call the scripts after exporting the effort, or run the extraction inline — both land under `.planning/<effort>/sdd/`. The inline forms keep the controller's context lean (the shell writes the file; only the path is handed to the subagent, which `read`s it):

- **task brief** — extract Task N's section (fence-aware) to `.planning/<effort>/sdd/briefs/task-<N>-brief.md`:

````bash
awk -v n=N '/^```/{f=!f} !f&&/^#+[ \t]+Task[ \t]+[0-9]+/{t=($0~("^#+[ \t]+Task[ \t]+"n"([^0-9]|$)"))} t{print}' .planning/<effort>/plans/<plan>.md > .planning/<effort>/sdd/briefs/task-N-brief.md
````

- **review package** — commits + stat + diff to `.planning/<effort>/sdd/reviews/review-<base7>..<head7>.diff`:

````bash
{ echo "# Review package: <base>..<head>"; echo; echo "## Commits"; git log --oneline <base>..<head>; echo; echo "## Files changed"; git diff --stat <base>..<head>; echo; echo "## Diff"; git diff -U10 <base>..<head>; } > .planning/<effort>/sdd/reviews/review-<base7>..<head7>.diff
````

Both keep the controller's context lean — the shell writes the file, only the path is handed to the subagent (the child `read`s it). The awk is the byte-identical script's logic inlined (validated BSD-awk-compatible on macOS).

Either path is fine: `PI_PLANNING_EFFORT=<effort> sdd-workspace` prints `.planning/<effort>/sdd/` (and `task-brief`/`review-package` inherit the env), or use the inline forms above. The awk is BSD-awk-compatible on macOS.

## Document-reviewer dispatches

Spec/plan critic passes (see pi-routing.md "Reviewer second pass") are plain
`spawn_subagent` dispatches: the task carries the artifact path + the template
path (`skills/brainstorming/spec-document-reviewer-prompt.md` for specs,
`skills/writing-plans/plan-document-reviewer-prompt.md` for plans); a read-only
reviewer needs no `commitScope` (pass `[]` or omit), no `watchdog`.
