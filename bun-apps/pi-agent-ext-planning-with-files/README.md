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

Since v1.2.0 (extended in v1.3.0) the extension ships **8 skills** (registered via `pi.skills: ["./skills"]`, loaded on-demand). The planning-with-files skill is the **file/orchestration substrate**; the others are the **methodology** that runs on top of it — adapted from [superpowers](https://github.com/obra/superpowers) (zh edition), re-mapped to Pi's tools (`todo`, `subagent`, `workflow`, `ask_user_question`) and conventions (CLAUDE.md PR workflow, `.planning/<slug>/`).

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
