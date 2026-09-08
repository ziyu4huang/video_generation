---
effort: 2026-09-06-self-arc-14
created: 2026-09-08
last: 2026-09-09
status: active
---

# Wayfinder map: 2026-09-06-self-arc-14 — qualify.ts: the 10-scenario deployed sweep becomes one command (with optional rpc pairing)

## Destination

One merged implementation PR ships `bun-apps/s2-agent-ext-subagent/scripts/qualify.ts` — an
allowlisted orchestrator that drives the PROVEN `tui-drive.ts` harness scenario-by-scenario
against a deployed launcher (`--sh`), each scenario as an INDEPENDENT spawned process, with
bounded concurrency, per-scenario receipt collection, one generated summary table (markdown +
json, committed to this map's `results/`), and a nonzero exit on any red scenario. Optional
`--rpc-pair` adds the first REAL use of the deployed `--mode rpc` lane (arc-13's verdict made
wiring): a structured cross-check probe per paired scenario via the importable arc-13 rpc
adapter. The pause-abort notification honesty fix (arc-11 finding) rides the same PR in
`s2-agent-ext-ultracode`. The arc closes with the FIRST non-ad-hoc full 10-scenario sweep —
run BY qualify.ts on the redeployed tree — green, its table committed, docs close-out PR
merged, and a validated successor next-goal. `tui-drive.ts` itself gets ZERO diffs.

## Context (measured 2026-09-08, planner recon in-tree)

- **The harness is single-scenario-per-process by design**: `tui-drive.ts` (1,418 LOC) parses
  `--scenario` at :92 and dispatches exactly one of ten scenarios at :1305–1314 (dispatch,
  parallel, viewer, agents, reload, swarm, catalog, workflow, wf-pause, cc-parity); usage line
  :28 is `bun … tui-drive.ts --sh <deployed>/s2-agent.sh --out /tmp/receipt`; output =
  `<out>/receipt.json` + numbered `snap-NN.txt` (:36); `sh` defaults to the repo source tree
  (:82). So the ad-hoc sweep's "3 concurrent batches" is literally N manual invocations —
  qualify.ts replaces the shell loop, not the harness.
- **The rpc adapter is importable library code**: `s2-agent-ext-subagent/scripts/lib/
  bench-base-tech/adapters/rpc.ts` exports `rpcAdapter: BenchAdapter` (:26); it spawns
  `[ctx.sh, "--mode", "rpc"]`, pumps JSONL (commands on stdin, responses + streamed
  `agent_settled` on stdout), and speaks `get_state` / `get_last_assistant_text`. The
  `scripts/lib/` subtree is contract-EXEMPT (`s2-agent-ext-devops/tests/scripts-dir-contract.test.ts:14`),
  and arc-13 D3 banned importing side-effectful SCRIPTS only — adapters under lib are not that.
- **The scripts-dir contract is a snapshot allowlist with no escape hatch**
  (`scripts-dir-contract.test.ts:23` `ALLOWED_RUNNABLE_ENTRIES`): a new runnable
  `bun-apps/s2-agent-ext-subagent/scripts/qualify.ts` requires its own allowlist row in the
  same PR or `s2-agent-ext-devops` gates fail.
- **The pause-abort seam is pinned but its renderer is not**: `workflow-tool.ts` background
  branch at :570 (`params.background ?? true`); the abort path at :616–625 sets
  `agent.error = "aborted"` and throws "Workflow was aborted";
  `s2-agent-core-runtime/src/errors.ts:105–127` `isAbortError` wraps ANY /abort/i message into
  recoverable `WORKFLOW_ABORTED`. Notably `grep -n pause workflow-tool.ts` returns NOTHING
  (2026-09-08) — pause/resume lives elsewhere (workflow-control-tool.ts / runtime), so the
  fix starts with a discovery step, not a patch.
- **The bias (c) is documented and contained, not urgent**: arc-13 map honest notes record
  screen-lane latency as post-verified-submit residuals vs rpc true turn times, contained by
  the 0.15 weight + role rule. Per-scenario WALL time measured by an orchestrator is free;
  true first-keypress→settle timing requires editing the proven harness.
- **Model + receipt discipline carry**: glm-5.3 only, never flash (arc-12 D5); receipts
  record the `sh` path (arc-13 D9); boot gate before first send, verified submit, dual-latch
  breaks, child-evidence gestures (arc-12/13 discipline).
- **Deployed launcher** (arc-13 verified): `/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current/s2-agent.sh`,
  `--mode rpc` present in its `--help`.
- **Name collision exists**: `.planning/2026-09-08-self-arc-14/` is a DIFFERENT series (B3
  migrate-in-parallel, research family). The self-evolve loop keeps the `2026-09-06-self-arc-*`
  prefix (arc-13 did the same: folder 2026-09-06-, created 2026-09-08). Always cite the full
  folder name.

## Tickets

### Phase 1 — driver (one implementation PR)

- `tickets/01-qualify-driver.md` — qualify.ts orchestrator + allowlist row + summary unit test. **status: ready**
- `tickets/02-rpc-pairing.md` — `--rpc-pair` structured cross-check via the arc-13 adapter (import-or-port spike). **status: ready, gated on 01**

### Phase 2 — honesty fix (same PR, different package)

- `tickets/03-pause-abort-honesty.md` — paused-then-resumed background promise reports paused/superseded, not failed. **status: ready (starts with discovery)**

### Phase 3 — prove + close

- `tickets/04-deployed-sweep-closeout.md` — merge → redeploy → first qualify-driven 10/10 sweep → results committed → docs close-out PR → successor next-goal. **status: blocked on 01–03**

## Decisions

- **D1 (2026-09-08) — ranking: (a) > (b) > (c), with (c) split.** (a) is pure orchestration
  around an unchanged harness — lowest risk, compounding ROI (every future arc's regression
  gate upgrades from hand-run shell batches to one command + committed table). (b) is a real
  UX lie in shipped product, small-to-medium, independent package — rides the same PR.
  (c) splits: per-scenario wall time rides (a) for free; in-harness first-keypress→settle
  retiming QUEUES as a successor candidate — harness stability beats a marginal metric whose
  bias is documented and contained (arc-13 honest notes).
- **D2 (2026-09-08) — spawn, never import, the scenarios.** Each scenario runs as an
  independent `bun tui-drive.ts --scenario <id> …` process against the deployed launcher,
  exactly as receipts were always taken; qualify.ts never links harness internals. tui-drive.ts
  gets ZERO diffs this arc (the constraint "additive and receipt-gated" is satisfied by vacuity).
- **D3 (2026-09-08) — rpc pairing imports the arc-13 lib adapter** (`scripts/lib/` =
  contract-exempt, not side-effectful; arc-13 D3 banned importing side-effectful scripts
  only). Fallback: port the minimal JSONL client (~80 LOC) if `LaunchCtx`/types coupling
  drags in more adapter surface than the port costs. Pairing is opt-in (`--rpc-pair`), and
  may pair a SUBSET of scenarios if measured probe cost is high — default proposal: dispatch,
  workflow, wf-pause (the arcs' regression core).
- **D4 (2026-09-08) — qualify.ts contract**: `--sh <launcher> [--scenarios a,b,c]
  [--concurrency 3] [--rpc-pair] [--out root]`; per-scenario exit/receipt → one summary
  (markdown + json: scenario, pass/fail, wall ms, receipt path, rpc cross-check when paired);
  exit nonzero on any red; receipts under `output/qualify14-*/` (scratch, never committed);
  generated tables committed to `.planning/2026-09-06-self-arc-14/results/`.
- **D5 (2026-09-08) — model honesty + receipt discipline carry unchanged**: glm-5.3 only,
  flash excluded BY NAME; every receipt records the sh path; boot gate before first send.
  Note arc-13 discovery: rpc `get_state` `data.model` is an OBJECT — the model check reads
  the field, not the shape.
- **D6 (2026-09-08) — honesty semantics for (b)**: a PAUSED-then-resumed run's FIRST
  background promise must surface paused/superseded — never "✗ … failed: Subagent was
  aborted". Fix at the promise/delivery seam with a unit test; tool DESCRIPTIONS unchanged →
  schema-cost +0 by construction.
- **D7 (2026-09-08) — the allowlist row ships in t01's diff** (snapshot contract has no
  override; a forgotten row fails `s2-agent-ext-devops` gates immediately — cheap, safe).
- **D8 (2026-09-08) — dormant rider allowed**: the `.distill-state.json.tmp` .gitignore
  one-liner (dormant since arc-13) rides the implementation PR. Nothing else dormant rides.

## Frontier

`tickets/01-qualify-driver.md` — it is first because it is pure addition (new file + one
allowlist row + a summary unit test over fixture receipts), touches no proven code, and every
later ticket (rpc pairing, the redeployed sweep, close-out) consumes its output shape.

## Fog of war

- WHERE the "✗ … failed: Subagent was aborted" line is rendered (background deliverer vs
  manager vs runtime) — t03 discovery step; only the throw sites are pinned today.
- Whether `rpcAdapter`'s `LaunchCtx`/`BenchAdapter` surface fits qualify without dragging
  the bench env/model plumbing — t02 spike decides import vs ~80-LOC port (D3 fallback).
- Real cost of an rpc probe per scenario (full session spawn + one ask settle ≈ tens of
  seconds) — decides full vs subset pairing (D3).
- Whether the pause path routes through `workflow-control-tool.ts`, the runtime signal, or
  both — discovery may reveal the honest fix needs a supersede marker at journal-resume time
  rather than at promise rejection.

## Cross-effort links

Builds-on: `2026-09-06-self-arc-13` (the benchmark that proved both lanes on the deployed
tree — this arc is the rpc verdict's first wiring; D3 port-never-import narrowed to
side-effectful scripts; D5/D9 discipline inherited).
Builds-on: `2026-09-06-self-arc-12` (tui-drive harness + 10/10 sweep receipts; model policy;
verified-submit/boot-gate receipt discipline).
Shares-decision-with: `2026-09-06-self-arc-13` D10 (scripts-dir shape: one runnable entry +
libs under `scripts/lib/` — qualify.ts is that shape again).

## Shipped-as (2026-09-09)

PR #2223 (merged CLEAN, squash lineage on 0.10.2+g4190dd5): qualify.ts + scripts/lib/qualify/
(6 unit gates), --rpc-pair (first real wiring of arc-13's structured-complement verdict —
import path won, no port needed), pause-abort honesty (5 unit gates). t04 receipt — the
FIRST non-ad-hoc deployed sweep, driven entirely by qualify.ts with --rpc-pair:

```
# qualify — tui-drive deployed sweep

Scenarios: 10 · green: 10 · red: 0

| scenario | verdict | wall | rpc |
|---|---|---|---|
| dispatch | ✅ | 56.9s | model-ok+settled (1s boot) |
| parallel | ✅ | 58.6s | — |
| viewer | ✅ | 45.0s | — |
| agents | ✅ | 17.1s | — |
| reload | ✅ | 63.4s | — |
| swarm | ✅ | 24.8s | — |
| catalog | ✅ | 18.8s | — |
| workflow | ✅ | 37.5s | model-ok+settled (1s boot) |
| wf-pause | ✅ | 63.6s | model-ok+settled (1s boot) |
| cc-parity | ✅ | 83.6s | — |


```

The wf-pause scenario's deployed snaps show the corrected line where the arc-11 snaps
showed the lie: `⏸ Background workflow … paused — superseded by resume … /workflows
resume …` — never `✗ … failed` for a parked, resumable run. Receipts:
`output/qualify14-full-deployed/` (scratch). Fog resolutions: rpc adapter imported
cleanly (no port); probe cost cheap (1s boot) but pairing stays on the 3 async-lifecycle
scenarios by design.
