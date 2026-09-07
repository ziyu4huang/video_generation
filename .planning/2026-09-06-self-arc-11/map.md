---
effort: 2026-09-06-self-arc-11
created: 2026-09-07
last: 2026-09-07
status: active
---

# Wayfinder map: 2026-09-06-self-arc-11 — pause levers, live model inheritance, honest gates

## Destination

The subagent/ultracode family behaves like Claude Code on three concrete
points: a background workflow can be PAUSED and RESUMED live with a receipt
proving it (not just a unit test), an untagged `spawn_subagent` verifiably
inherits the parent session's model on BOTH source and deployed trees, the
deploy e2e gate stops flapping red on latency-spike kill-caps, and `/agents`
ships real builtin agent packs instead of an env seam with no producer.

## Context

Measured 2026-09-07 by the hard-problem planner (every citation read in-tree):

- **Ledger (a) is STALE.** The registration DOES wire `getMainModel`:
  `bun-apps/s2-agent-ext-subagent/extensions/subagent.ts:74` (`mainModelHolder`),
  populated at `session_start` (line 311, `ctx.model → "provider/id"`) AND on
  `model_select` (line 319); threaded at lines 110 (`createSubagentTool`) and
  164 (`createSubagentsTool`). Consumed: `src/subagent-tool.ts:300` →
  `modelCtx.mainModel` (line 402) → `@repo/s2-agent-core-runtime`
  `agent-model.ts:67` (session-default branch returns mainModel) and
  `:123` (scope clamp prefers mainModel). What remains: a STALE comment
  claiming the opposite (`src/subagent-tool-render.ts:115` — "getMainModel is
  not wired in production") and NO deployed-side proof.
- **Ledger (b) confirmed.** `tui-drive.ts` `scenarioWorkflow` (lines 631–716)
  drives start → viewer → x-abort only; zero pause/resume gestures. Pause UX
  EXISTS on `/workflows` navigator: `workflow-ui.ts:521` `case "p"` →
  `manager.pause(id)` (:628), footer hint at :470. `/subagents` viewer
  (`subagent-viewer.ts`) has NO pause key — only the x-abort lever (:149/:177).
  Arc-10 shipped `paused` status vocabulary + `⏸` icons (`task-panel.ts:261`).
- **Ledger (c) confirmed.** `s2-agent-ext-devops/tests/e2e-core-tool-roundtrip.test.ts`:
  `PRIMARY_CAP_MS = 90_000` (:81), hard kill at :128 (`proc.kill(9)`), one
  artifact-retry pattern exists for exit-0-no-artifact (:181–185) — the
  template to mirror. Live red on 2026-09-07 (arc-10 close-out, env latency).
- **Ledger (d) seam confirmed.** `agents-command.ts:50`
  `resolvePackDirs(cwd, env = S2_AGENT_PACK_DIRS)`; pack def format is
  frontmatter markdown (`tests/agents-viewer.test.ts:450`:
  `---\nname: env-worker\ndescription: …\n---\nPrompt.`); loaded via
  `loadAgentRegistry(cwd, { packDirs })` (:71–72). No producer anywhere
  (grep: only the seam + tests).
- Receipt machinery: `tui-drive.ts` already has `--expect-model RE`
  (default `/glm/`, :75) latching `receipt.checks.modelIsGlm` (:1056) against
  the dispatch row's model line — the inheritance receipt leg is an extension
  of an existing latch, not new plumbing.
- Pre-existing noise (leave alone): `esc-settle-detector.ts` useRegexLiterals.

## Tickets

Phase 1 — core receipts (the arc's headline)
- [ ] t01 — live pause/resume receipt leg (wf-pause scenario) [subagent + ultracode read-only]
- [ ] t02 — getMainModel honesty: kill the stale comment + inheritance receipt legs [subagent]

Phase 2 — gate + producer
- [ ] t03 — e2e-core-tool-roundtrip: retry-once on kill-cap, counted [devops]
- [ ] t04 — builtin agent pack producer + /agents receipt latch [subagent]

Phase 3 — close-out
- [ ] t05 — one PR through devops chain; deployed receipt legs; sweep re-run; map close-out

## Decisions

- D1: **Ledger (a) rescoped to drift + proof.** The wiring exists (Context
  citations); re-implementing it would be re-deciding a shipped decision. The
  honest work is the stale comment (render file claims the opposite of the
  registration file) and the live + deployed receipts.
- D2: **Pause receipt uses the EXISTING `/workflows` `p` key.** No new keymap
  on `/subagents` this arc: the CC-like pause surface is the workflow
  navigator (CC itself has no pause on its task rows); a viewer `p` lever
  needs registry plumbing (RunView + registerInFlight) sized like arc-10's
  abort lever — DESCOPED to fog-of-war unless the arc finishes early.
- D3: **t03 retry keyed on the kill signal, not exit code alone**
  (Bun `proc.kill(9)` may surface as signal `SIGKILL` or code 137 depending
  on wrapper) — one retry, loudly counted, second failure still FAILs.
- D4: **t04 builtin pack = source-shipped directory, not a build step.**
  `packs/builtin/` inside s2-agent-ext-subagent; `resolvePackDirs` appends it
  after env dirs so user packs win name collisions. Deploy-safe: the deploy
  mirrors bun-apps verbatim.
- D5: Schema-cost stays +0 — no tool description strings change in this arc
  (t01/t02/t04 touch renderer comments, scripts, and a TUI footer at most).

## Frontier

t01 first — it is the only ticket with a live-loop discovery risk (whether
`p` on the navigator repaints the shared `/subagents` wf row's `⏸` without a
reopen — the arc-10 change-channel payoff). t02 second (trivial edit + runs
on the same receipt harness). t03/t04 are isolated.

## Fog of war

- Whether the wf row on `/subagents` flips to `⏸`/paused on navigator `p`
  with no reopen (arc-10 t01 stamps the registry; the viewer repaint is
  receipt-verified, not unit-verified). If it does NOT repaint, the fix is the
  change-channel invalidate path, in-scope for t01.
- Whether `receipt.modelLine` in the dispatch scenario reflects the RESOLVED
  child model (post `onModelResolved`) vs the requested slot — t02 verifies
  before claiming the inheritance latch; if it only shows the slot, extend
  modelLine capture to the resolved segment (composer closure re-reads the
  registry per tick — subagent-tool.ts renderCall).
- `loadAgentRegistry` name-collision order for pack dirs (first-wins vs
  last-wins) — t04 reads it before fixing the append order.
- Descope candidate if the arc overruns: t04 (standalone, no dependencies).

## Cross-effort links

- Builds-on: `2026-09-06-self-arc-10` (paused vocabulary, wf rows, abort
  lever, qualification sweep), `2026-09-06-self-arc-9` (defect-A honesty fix
  that motivated the stale comment; tui-drive scenario discipline).
- Shares-decision-with: `2026-09-06-learnings-hardening` (deployed≠source:
  the t02 deployed-bundle grep leg is learning #1 applied).

## Shipped-as (close-out)

PR #2204 merged CLEAN on the FOURTH gate attempt — three real bounce lessons,
all now encoded:
1. `AgentDefinition` requires the `source` discriminant (builtin pack defs
   initially omitted it).
2. `arc-plan.ts` was missing from the devops scripts-dir-contract runnable
   allowlist (the loop opener is a runnable entry — now registered).
3. THE BIG ONE: the deploy e2e's kill-cap retry did not fire — bash wraps
   SIGKILL as exit +137, so `timedOut` (code null/neg) missed it. Fixed to
   `(timedOut || code === 137) ∧ cap-elapse`; the retry then absorbed the
   latency spike and the gate went green. Exactly the fallback the planner's
   D3 anticipated.

## FULL pipeline qualification (deployed `0.10.0+gf2e08b9`, 2026-09-07)

All NINE tui-drive scenarios PASS, three concurrent batches, zero required
checks failed (receipts `output/qual2-*/`):

| scenario | pass | snaps |
|----------|------|-------|
| dispatch | ✓ | 29 |
| parallel | ✓ | 20 |
| viewer   | ✓ | 10 |
| agents   | ✓ | 10 |
| reload   | ✓ | 23 |
| catalog  | ✓ | 7  |
| swarm    | ✓ | 12 |
| workflow | ✓ | 14 |
| wf-pause | ✓ | 22 |

Deployed-artifact legs: `getMainModel` ×4 in the deployed ext bundle (t02 —
wiring survives minification); builtin pack rows (`extension pack` label,
code-reviewer / test-writer visible) in the deployed /agents (t04).
