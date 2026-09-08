# t02 — `--rpc-pair`: structured cross-check lane

**status: ready, gated on t01** · package: `s2-agent-ext-subagent`

## Goal

First REAL use of arc-13's rpc verdict: alongside the screen sweep, optionally spawn
`--mode rpc` probes on the deployed launcher and record structured evidence
(`get_state` model check + one trivial ask settling on `agent_settled`) per paired
scenario in the summary.

## Steps

1. Spike (≤1h): import `rpcAdapter` from `scripts/lib/bench-base-tech/adapters/rpc.ts`
   and drive `launch(ctx)` + a get_state + one prompt→`agent_settled` against the
   deployed `s2-agent.sh`. If LaunchCtx/types coupling drags the bench env/model plumbing,
   PORT the minimal JSONL client (~80 LOC) into `scripts/lib/qualify/` instead (D3
   fallback — both outcomes recorded in the map's Fog resolution).
2. Wire `--rpc-pair` into qualify.ts: default OFF; when on, pair the D3 subset
   (dispatch, workflow, wf-pause) unless probe cost measures cheap, then all 10.
   Probe result lands in the summary's rpc column: `model-ok` (reads `data.model` —
   an OBJECT per arc-13; check the field, not the shape), `settled` (ask settled via
   streamed `agent_settled`), or the failure string. A failed rpc probe marks the
   scenario cell RED but does not flip the screen verdict (complement, not gate) —
   record both lanes side by side.
3. Extend the summary unit test with a fixture rpc cross-check cell.

## Constraints

- Children LLM = zai/glm-5.3, never flash (D5). rpc probe receipts under `output/` only.
- The adapter lib itself stays UNMODIFIED — if it needs a change, that is the port signal.

## Done when

- `--rpc-pair` run against the deployed tree yields per-pair structured cells in
  summary.md/json; gates green; import-vs-port outcome recorded in the map.
