# self-arc-24 plan request — s2-agent-ext-ultracode → Claude Code parity (function + TUI)

You are planning self-arc-24 of the s2-agent self-evolve arc. READ BUDGET: at most ~12 reads total, then WRITE the plan.

## Numbering (arc-ledger)

`.planning/arc-ledger.json` already has number 24 claimed (status "active", this branch,
`self-arc-24-ultracode-cc-parity`, folder `.planning/2026-09-11-self-arc-24-ultracode-cc-parity/`).
Your map lives at that exact path; do NOT invent another number.

## User directive (verbatim intent)

"search internet use subagent and planning use planner subagent (zcode) try to find out how
claude-code works both in function and tui, and try to improve s2-agent-ext-ultracode ensure
it similar to claude-code — use self-develop-arc, and ensure the verified use the deployed
version with isolation work env to verified."

The internet research is DONE: two GLM-5.3 children ran through the DEPLOYED s2-agent
(web tools) and returned cited digests, now committed:
- `.planning/2026-09-11-self-arc-24-ultracode-cc-parity/evidence/cc-function-digest.md`
- `.planning/2026-09-11-self-arc-24-ultracode-cc-parity/evidence/cc-tui-digest.md`

Their bottom-line checklists are quoted below — these define "similar to Claude Code" for
this arc. You decide which gaps ultracode should CLOSE NOW (2–4 implementation tickets max)
vs CHART (Loop findings / follow-ups), given size and the verification cost.

## What ultracode already has (verify only where you rely on it)

Fan-out orchestration (`agent/parallel/pipeline/phase`, vm sandbox), per-agent model/tier
routing, `isolation:"worktree"`, journaled resume, background-by-default runs + live task
panel (compact/detailed with tok/s), `/workflows` navigator (drill phases→agents→detail;
pause/stop/restart/save keys), `/deep-research`, `/adversarial-review`, `/ultracode` +
`/effort off|high|ultra` standing opt-in, saved workflows as `/<name>` commands, cron +
wakeup registry, checkpoint() human gates, schema-validated outputs, budget directives.
Key files: `bun-apps/s2-agent-ext-ultracode/src/{workflow-tool,workflow-ui,task-panel,
display,effort-command,workflow-runtime,workflow-manager}.ts`.

## Candidate gaps (recon hypotheses — VERIFY each against code before ticketing)

1. **Pre-flight ceiling-confirm before an armed ultra workflow** — self-charted in code:
   `effort-command.ts:5-11` says the `input` hook can't await a confirm, so an armed
   substantive message launches a potentially huge fan-out with NO downscope point.
   CC parity: permission ASK with numbered choices + "don't ask again" (digest §7).
   Feasibility probe: `workflow-tool.ts:539-544` already threads a `ctx.ui.confirm`
   yes/no for checkpoints — the tool-call path CAN await UI; a confirm keyed on
   effort=ultra + absent explicit budget may belong at the tool boundary (where
   tokenBudget/maxAgents are known), not the input hook.
2. **checkpoint() renders as yes/no only** (`workflow-tool.ts:539` maps to
   `ctx.ui.confirm(title, message): Promise<boolean>`). CC parity: numbered choice
   lists with arrow/number selection (digest §7). Check `workflow.ts` CheckpointOptions —
   if checkpoint() already accepts options/default, the parity surface is rendering +
   an options-aware UI contract.
3. **No persistent armed-state badge** — CC shows a persistent footer badge for mode
   state ("⏸ plan mode on", digest §5). ultracode shows a keyword highlight in the
   editor only while typing (see `workflow-editor.ts`) and `/effort` just prints a
   message; a session with effort=ultra armed looks identical to off in the UI.
4. **Navigator detail lacks per-history timestamps** (CC Ctrl+O transcript parity:
   "expanded tool usage, timestamps, model per message", digest §4/§7). Check what
   `workflow-ui.ts` renders per agent-history entry (model per agent IS shown).
5. **Workflow-run steering** — CC queues guidance delivered at tool boundaries
   (digest §6). self-arc-23 (#2264/#2269) shipped honest 3-way steering for
   registry subagents (core-runtime live-agent machinery, register-before-first-exchange),
   but workflow runtime agents are separate sessions unreachable by
   `list_subagent_runs steer`. A `/workflows steer <id> <text>` delivering to the
   run's currently-running agent(s) would close real parity — size it honestly;
   if >1 ticket of work, chart the design and land only the plumbing seam.
6. CHART-ONLY candidates (name in Loop findings, no ticket): main-loop worktree
   enter/exit tool, customizable statusLine (JSON-on-stdin), spinner verb line,
   plan-mode ring — these are pi-core/s2-agent-core surfaces, not ultracode.

## Standing constraints (the loop's playbook)

- Tickets ≤ 4 implementation + 1 verification/close-out; every ticket names file:line anchors.
- Gates: biome (pinned 2.4.16) + tsc + bun test per touched package; local-ci per package
  via the devops chain; tool-description changes account schema-cost
  (`cli tools-metrics --schema-cost --json`).
- Verification leg (t-last): drive the DEPLOYED tree (deploy-cli to a pinned immutable
  version dir — never `current`, playbook PB-08; grep-assert distinctive new symbols in
  the shipped bundles BEFORE driving, PB-09). Capture a PRE-fix receipt first if a red
  is found (PB-10). Receipts + any red evidence land in the arc folder's evidence/
  (committed, PB-18). output/ is scratch.
- Isolated work env (user requirement): the deployed verification drives an ultracode
  workflow inside a THROWAWAY scratch git repo (seeded fixture under output/), with
  assertions that `isolation:"worktree"` agents commit on worktree branches and the
  scratch repo's main worktree stays clean, and NOTHING outside the scratch env changes
  (parent repo `git status` clean after the drive). Also run the tui-drive scenario that
  exercises the shipped surface(s) against the pinned deploy.
- GLM-5.3 everywhere (zai), never flash — children in receipts must prove model.

## Output shape (write ONE markdown answer; it becomes map.md + tickets verbatim)

1. Frontmatter block: `effort: 2026-09-11-self-arc-24-ultracode-cc-parity / created: 2026-09-11 /
   last: 2026-09-11 / status: active`.
2. `## Destination` — what "similar to Claude Code" concretely means after this arc
   (the shipped parity deltas, each falsifiable).
3. `## Context` — current state with file:line anchors; which hypotheses you VERIFIED
   (and which you rejected, with the evidence), research digest citations.
4. Tickets as `### t0N — <slug>` sections, each with: Goal / Files / Steps /
   Tests+Gates / Done-when. Order: implementation tickets first, verification leg
   second-to-last, close-out last.
5. `## Loop findings` — charted-not-landed items (from candidate 6 + anything you
   descoped), each one line with an anchor.
6. `## Execution order` + risks (deploy cache, sibling-loop collisions on
   bun-apps/s2-agent-ext-ultracode — arc-18 touched it last via #2237; re-sync
   origin/main before each PR).
