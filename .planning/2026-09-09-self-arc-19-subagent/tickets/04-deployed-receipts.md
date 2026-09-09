# t04 — deployed verification receipts (redeploy, then drive the real TUI)

Status: open (blocked by the implementation PR merging)
Files: none committed — receipts land under `output/self-arc19-*<date>/` (scratch,
never committed). Driven FROM this worktree.

## Goal

Prove the arc on the deployed artifact, not the source tree: dispatch receipt with
`liveModelSlot` LATCHING (the wrap-fix proof), provenance stamped in every receipt,
steer-verb evidence, and depth-cap evidence — all against
`/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current/s2-agent.sh`.

## Preconditions

- t01+t02+t03 merged green (local-ci, scope-verified) on `self-arc-19-subagent` → main.
- **Redeploy first** (map D5): run deploy-cli so the dist tree carries t02/t03 runtime
  code (the current dist `0.10.0+g80419f1` predates them — steering/depth checks
  against it would test ancestors). verify-deploy-e2e runs automatically post-deploy;
  confirm it passed BEFORE driving. Fallback only if deploy is broken: mark those
  checks `source-tree-only: true` with a one-line reason in the receipt — explicitly,
  never silently.
- LM Studio / zai key wiring as in prior arcs; children zai/glm-5.3, never flash (D9).

## Work items

1. **dispatch (headline)**: `tui-drive --scenario dispatch --sh <dist>/current/s2-agent.sh`
   with COLS=100 (unchanged — the wrap must occur for the proof). PASS requires
   `liveModelSlot: true` latched in-loop AND the receipt's `launcher` block showing
   shRealpath under dist + the redeployed version + gitSha of the merged commit.
   Compare against `output/self-arc14-deployed-dispatch-20260908/` (the false-FAIL
   baseline — keep it, do not delete).
2. **steer evidence**: minimal path — a drive (or scripted session) that starts a
   background run, calls `list_subagent_runs({action:"steer", id, message})` with an
   observable instruction, and receipts the child acknowledging the steered content;
   flash-excluded model check applies to the child.
3. **depth-cap evidence**: unit tests from t03 satisfy source-tree proof; deployed
   evidence = one scripted nested spawn exceeding max 2 returning the clean rejection
   (seed a tiny agentType def with `maxDepth` via the drive's def-seeding mechanism if
   the live catalog lacks one).
4. Re-run any scenario touched by the vocab table (e.g. agents, wf-pause) to confirm
   zero check-name drift — receipts should be structurally identical to arc-14's.

## Acceptance

- dispatch receipt PASS with `liveModelSlot` latching + full launcher provenance.
- Steer receipt PASS on the redeployed tree (or explicit source-tree-only marker).
- Depth-cap rejection observed on the redeployed tree (or same marker).
- No receipt file under `output/` is deleted or rewritten to pass.

## Operating learnings that apply

#1 (verify the artifact — grep the deployed bundle for a new symbol like the steer
action string if a check behaves oddly before blaming the harness), #3/#4 (paced
keys, TERM=xterm-256color, chunked feed — already encoded in tui-drive), #5 (judge
running-vs-settled on live markers only). State in the receipt notes which applied.
