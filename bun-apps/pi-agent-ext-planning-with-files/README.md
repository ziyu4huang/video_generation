# pi-planning-with-files

A **Pi-native** port of [planning-with-files](https://github.com/OthmanAdi/planning-with-files) (v3.4.0) — the open-source standardization of Manus's "markdown = working memory" insight. Ships as a first-class Pi extension package: a Layer-3 runtime that keeps an agent anchored to `task_plan.md` / `findings.md` / `progress.md` across long, multi-step goals.

**Pure TypeScript — no `python3`, no `uv`, no `.sh`/`.ps1` scripts.** Attestation uses `node:crypto`; session catchup is a `git diff --stat` summary. This is the authoritative, current-namespace (`@earendil-works/*`), v3.4.0, bun-native Pi version.

## What it does

The extension maps the upstream planning-with-files hook design onto Pi's lifecycle events:

| capability | implementation |
|---|---|
| 6-event lifecycle | `session_start`, `before_agent_start`, `tool_call`, `tool_result`, `agent_end`, `session_before_compact` (+ `session_shutdown`, `input`) |
| 4 injection modes | `auto` (default → `parity` except DeepSeek → `cache-safe`), `parity`, `cache-safe`, `notify` |
| 9 slash commands | `/plan-status` (+token cost), `/plan-attest [--show\|--clear]`, `/plan-goal`, `/plan-execute [reset]`, `/plan-done [--delete]`, `/plan-loop [interval] [prompt]`, **`/plan-list`**, **`/plan-lint [--all]`**, **`/plan-switch <id>`** (PLI v2) |
| SHA-256 attestation | tamper detection → injection blocked (`[PLAN TAMPERED]`); pure-TS via `node:crypto` |
| `/plan-execute` gate | hooks stay passive until the user approves the plan (v3.3.0) |
| `/plan-done` close-out | finished/abandoned plan → `<!-- pwf: closed -->` marker; hooks go inert (no nag/auto-continue). `--delete` removes the files |
| auto-continue | incomplete plan → follow-up, limit 3 per (session, plan) |
| plan-loop timer | periodic re-tick (default 10m), auto-stop on completion |
| dangerous-bash guard | word-boundary regex: `rm -rf`, `sudo`, `git push --force`, fork-bomb… |
| PreToolUse recitation | plan head injected as `steer` before tracked tool calls |
| cache-safety | stable reminder strings in cache-safe mode (DeepSeek KV-cache friendly) |

## Skill suite (methodology on top of the substrate)

Since v1.2.0 (extended in v1.3.0, expanded to 11 in v1.4.0 and to 12 in v1.4.1) the extension ships **12 skills** (registered via `pi.skills: ["./skills"]`, auto-discovered, loaded on-demand). The planning-with-files skill is the **file/orchestration substrate**; the others are the **methodology** that runs on top of it — adapted from [superpowers](https://github.com/obra/superpowers) (zh edition), re-mapped to Pi's tools (`todo`, `subagent`, `workflow`, `ask_user_question`) and conventions (CLAUDE.md PR workflow, `.planning/<slug>/`).

```
test-driven-development = the FOUNDATION (red-green-refactor) every plan step assumes

brainstorming  ──(approved design)──►
writing-plans   ──(good plan CONTENT)──►  planning-with-files  = file/orchestration SUBSTRATE
executing-plans ──(per-task EXECUTION)──►    (hooks, nags, progress.md, /plan-execute gate)
                     ├── verification-before-completion  (gate at every task + at completion)
                     └── systematic-debugging            (on any test failure / blocker)

writing-skills = the META — governs how to author/maintain the whole suite
```

| skill | role | discipline elements |
|---|---|---|
| `planning-with-files` | substrate — where plans live, hooks, `/plan-*` commands | — |
| `test-driven-development` | the **foundation** — red-green-refactor; no production code without a failing test | rationalization table + red-line list |
| `brainstorming` | **before** planning — explore intent → design → approval (hard-gated) | hard-gate |
| `writing-plans` | plan **content quality** — small TDD steps, no placeholders, self-check | no-placeholder rules |
| `executing-plans` | **execution discipline** — critical review, per-task rhythm, blocker escalation | stop-and-ask rules |
| `verification-before-completion` | cross-cutting **gate** — no "done" claim without fresh evidence | rationalization table + red-line list |
| `systematic-debugging` | **error recovery** — root-cause first; 3-strike → question architecture | rationalization table + red-line list |
| `writing-skills` | the **meta** — TDD-for-docs; governs how to author/maintain the suite | CSO rules + checklist |

The methodology skills are written to **complement, not duplicate** the substrate: `writing-plans` and `executing-plans` explicitly defer file mechanics / progress tracking to planning-with-files. Skill descriptions follow the [writing-skills CSO rule](https://github.com/obra/superpowers): trigger-only (`Use when…`), never a workflow summary. A deterministic test (`tests/skills.test.ts`) guards these rules.

## Install (local)

This package is used as a **local Pi extension** — no npm publish required.

```bash
# Option A: register it in Pi settings (survives restarts)
pi install ./bun-apps/pi-planning-with-files

# Option B: load it ad-hoc for one run
pi -e ./bun-apps/pi-planning-with-files/extensions/index.ts
```

Both load the extension **and** the skill (`skills/planning-with-files/SKILL.md` + templates) via the `pi` manifest in `package.json`.

## Usage

1. Create the three planning files in your project root (or under `.planning/<slug>/` for parallel tasks). Templates live in [`skills/planning-with-files/templates/`](./skills/planning-with-files/templates/).
2. Run `/plan-execute` to approve the plan and activate the hooks (the hooks stay passive until you do — a safety gate).
3. (Optional) `/plan-attest` to SHA-256-lock the plan; any later silent edit fails the hash check and blocks injection.
4. Work. The extension injects the current plan + progress into each turn, recites the plan head before tool calls, guards dangerous bash, and auto-continues until all phases are complete.

## Recommended workflows

The extension is one half of the system (the **substrate**); the 12 shipped skills are the other half (the **methodology**). The skill flow is what the runtime runs on top of:

```
test-driven-development = the FOUNDATION (red-green-refactor) every step assumes

brainstorming   --(approved design)----┐
writing-plans   --(good plan content)----┤
executing-plans --(per-task execution)----┴--> planning-with-files (SUBSTRATE)
                                              ├── verification-before-completion (gate)
                                              └── systematic-debugging (on failures)

using-git-worktrees + finishing-a-development-branch = sibling-worktree lifecycle
subagent-driven-development                         = per-task isolated execution
writing-skills   = the META (governs authoring the suite)
self-improvement = the loop-closing META (evolves the suite)
```

Pick a workflow by the shape of the work:

### Workflow A — Build a feature the right way (full chain)

Use for any feature or non-trivial change. This is the intended end-to-end flow.

```
1. brainstorming        -> explore intent, get an approved design (.planning/<slug>/design.md)
2. writing-plans        -> turn the design into task_plan.md with small TDD steps
3. /plan-execute        -> approve the plan, activate the hooks
4. executing-plans      -> execute phase-by-phase, using:
     ├── test-driven-development        (red-green-refactor each step)
     ├── verification-before-completion (fresh evidence before "done")
     └── systematic-debugging           (on any test failure / blocker)
5. /plan-done           -> close the plan when finished
```

### Workflow B — Lightweight planning (no ceremony)

For 5+ tool-call tasks that don't warrant full brainstorming.

```
1. Copy templates  -> skills/planning-with-files/templates/{task_plan,findings,progress}.md
2. Fill task_plan.md with phases
3. /plan-execute   -> hooks active
4. Work, updating progress.md after each phase
5. /plan-done      -> when done
```

### Workflow C — Parallel multi-task (PLI v2)

For several features in flight in the same repo at once.

```bash
mkdir -p .planning/2026-07-12-refactor-auth
mkdir -p .planning/2026-07-12-add-lora-import
# each session resolves its own plan; pin one with:
export PLAN_ID=2026-07-12-refactor-auth
# then navigate between them:
/plan-list            # see all plans
/plan-switch <id>     # jump between them
/plan-lint --all      # health-check every plan
```

### Workflow D — Long-running autonomous loop (CI / batch)

```bash
# opt-in auto-approval (no interactive /plan-execute needed)
PWF_AUTO_APPROVE=1 pi -e ./extensions/index.ts -p "..."

# or set a recurring tick that re-drives the agent every 10m until the plan is complete:
/plan-loop 10m
/plan-goal "all phases complete and tests green"
```

### Workflow E — Secure / audited plan (attestation)

```
1. Finalize task_plan.md
2. /plan-attest          -> SHA-256 lock
3. Work — any silent edit to task_plan.md -> injection blocked with [PLAN TAMPERED]
4. /plan-attest --show   -> audit the hash
5. /plan-attest --clear  -> re-approve after intentional edits
```

### Workflow F — Coordinating with /goal (three-layer model)

When `/goal`, planning-with-files, and the `todo` tool are all active, they form three time-scales — not competing plans:

| Layer | Tool | Scope | Persistence |
|-------|------|-------|-------------|
| Objective | `/goal` | one goal, driven to completion | session JSONL |
| Plan | planning-with-files | multi-phase, cross-session | files on disk |
| Steps | `todo` tool | within a phase, in-session | session JSONL (branch-aware) |

When `/goal` is actively driving, the extension **yields** — it skips its own plan injection and auto-continue so the two don't double-drive, and `goal_complete` is blocked while a plan has open phases (run `/plan-done` to release). Use `todo` for the fine steps of the current phase, planning files for the cross-session phase breakdown, and `/goal` to drive the whole objective to done.

### Coordination with pi-agent-ext-wayfind (grill / wayfinder)

The same yield applies to an active [`pi-agent-ext-wayfind`](../pi-agent-ext-wayfind) session — a live `/grill-me-with-docs` or `/wayfinder` interview owns the turn just like `/goal` does. wayfind publishes `globalThis.__piWayfindActive`; this extension reads it via `isExternalDriverActive()` (alongside `isGoalActive()`) and yields its injection + auto-continue while the grill runs. The status bar reads `… — /goal or /grill driving, injection yielded`. The grill hands back with `/grill-done --seed-plan`, which writes a `task_plan.md` seed you then drive here with `/plan-execute`. Graceful: if wayfind isn't loaded, the seam is inert.

### Practical tips

- **Skip the substrate for** simple questions, single-file edits, or quick lookups (< 5 tool calls).
- **Closing a plan is mandatory.** A finished-but-unclosed plan nags at every `agent_end`. Always run `/plan-done` when done.
- **Write external/web content to `findings.md` only**, never `task_plan.md` — the plan is injected into the model on every turn, so untrusted content there is a prompt-injection amplifier.
- **Choose a mode from data**: run `/plan-status` to see the token cost (e.g. `~1137 tokens (parity)` vs `~45 tokens (cache-safe)`), then set `PWF_MODE` accordingly.

### Modes

Configure via `PWF_MODE` env, project `.pi/settings.json`, or global `~/.pi/agent/settings.json`:

```json
{ "planningWithFiles": { "mode": "cache-safe" } }
```

- `auto` (default): DeepSeek → `cache-safe`, other models → `parity`
- `parity`: full plan + progress block injection (maximum context)
- `cache-safe`: stable one-line reminders (KV-cache friendly)
- `notify`: status-bar only, no model injection

### PLI v2 — multi-plan intelligence commands

| Command | Description |
|---------|-------------|
| `/plan-list` | List **all** plans under `.planning/` (+ root) with status, phase progress, attestation state, and which is active |
| `/plan-lint [--all]` | Diagnose a plan: missing phase headers, unparseable status tokens, missing progress/findings, attestation tamper. `--all` lints every plan |
| `/plan-switch <id>` | Pin the active plan to `.planning/<id>` (validates existence + not-closed). `/plan-switch root` clears the pin |

`/plan-status` also now reports the **injection token cost** of the active mode (e.g. `~1137 tokens (parity)` vs `~45 tokens (cache-safe)`) so you can pick a mode from data.

### Non-interactive / CI auto-approval

Upstream requires an interactive `/plan-execute`. For CI or `pi -p` batch runs with an already-finalized plan, opt in:

```bash
PWF_AUTO_APPROVE=1 pi -e ./extensions/index.ts -p "..."
# or { "planningWithFiles": { "autoApprove": true } } in .pi/settings.json
```

This activates the hooks at `session_start` without a human in the loop. Off by default.

## Architecture

```
src/
  constants.ts    reminder strings, limits, data markers
  plan.ts         plan-file resolution + PlanStatus parser (pure)
  attestation.ts  SHA-256 check + attestPlan action (pure, node:crypto)
  modes.ts        mode parsing/derivation + auto-approve resolution
  scripts.ts      git-diff catchup + check-complete report (pure TS, no Python)
  guard.ts        dangerous-bash regex guard (pure)
  state.ts        per-session RuntimeState + session-key helpers
  lifecycle.ts    PLI v2: multi-plan enumerate / lint / switch (pure)
  tokens.ts       PLI v2: injection token-cost estimate (pure, no tokenizer dep)
  commands.ts     the 9 slash commands
  runtime.ts      event handlers + injection builders + default export
  index.ts        public API re-exports
extensions/
  index.ts        thin Pi entry point (default export)
skills/
  planning-with-files/{SKILL.md, templates/}
```

## Testing

```bash
# Unit tests (hermetic, fast) — the default `bun test`
( cd bun-apps/pi-planning-with-files && bun test )

# End-to-end (drives the REAL `pi` CLI against a live model)
RUN_E2E=1 bun test tests/e2e
```

The e2e suite is gated on `RUN_E2E=1` + a reachable provider (auto-detects `DEEPSEEK_API_KEY` → `deepseek-v4-flash`, else local LM Studio `gemma`). It asserts on the `pi --mode json` protocol stream — not the model's prose — so it's deterministic regardless of model. Three scenarios:

1. **load** — extension registers without error; a turn reaches `agent_end`.
2. **inject** — attested + auto-approved plan → the `before_agent_start` injection (plan token + `ACTIVE PLAN` marker) appears in the stream.
3. **tamper** — mismatched attestation → stream contains `PLAN TAMPERED` and the plan token is absent.

```bash
bun run check        # biome check
bun run build        # tsc → dist/
bun run test         # check + build + unit tests
```

## Credit

Upstream planning-with-files by [OthmanAdi](https://github.com/OthmanAdi/planning-with-files) (MIT, v3.4.0). The runtime logic is a faithful port; the changes are packaging (first-class Pi package, `dist/` build, `bun test`), de-Pythonization (attestation + catchup in pure TS), and the opt-in `PWF_AUTO_APPROVE` escape hatch for non-interactive use. The upstream repo is reference-only and never modified.

## License

MIT.
