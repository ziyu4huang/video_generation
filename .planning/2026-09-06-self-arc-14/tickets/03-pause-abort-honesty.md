# t03 — pause-abort notification honesty fix

**status: ready (starts with discovery)** · package: `s2-agent-ext-ultracode` (+ maybe `s2-agent-core-runtime`)

## Goal

Kill the UX lie (arc-11 finding, visible in wf-pause snaps): the FIRST background promise
of a paused-then-resumed workflow run reports "✗ … failed: Subagent was aborted" in the
transcript, though the run later resumes and completes. Honest semantics (D6): that first
promise must report paused/superseded — never failed.

## Pinned facts (2026-09-08 recon)

- `workflow-tool.ts:570` `if (params.background ?? true)` — the background branch;
  `:616–625` abort path sets `agent.error = "aborted"` and throws "Workflow was aborted".
- `s2-agent-core-runtime/src/errors.ts:105–127` — `isAbortError` wraps ANY /abort/i message
  into recoverable `WORKFLOW_ABORTED`.
- `grep -n pause workflow-tool.ts` → NOTHING: pause/resume lives elsewhere
  (workflow-control-tool.ts / workflow-runtime.ts resume-journal path) — the discovery
  target is where the background promise's rejection is RENDERED (deliverer / manager),
  and where a pause-induced abort is distinguishable from a user kill.

## Steps

1. Discovery: reproduce in a unit harness — start a background workflow run, pause it,
   assert the first promise's delivered text today contains "failed". Locate the
   render/deliver seam and the pause-vs-kill discriminator (grep `aborted`,
   `WORKFLOW_ABORTED`, the background deliverer under `s2-agent-ext-ultracode/src/`
   and core-runtime).
2. Fix at the seam: when the abort originated from PAUSE (run later resumable/resumed),
   the first promise's notification becomes "paused — superseded by resume" (exact wording
   to match existing notification style); user-killed aborts keep the failed text.
   Prefer classifying at throw time (carry a pause flag through WorkflowError) over
   string-matching at render time.
3. Unit tests at the seam: (a) paused→resumed → first promise = paused/superseded, NOT
   failed; (b) user abort → still failed; (c) normal completion → unchanged.
4. Tool DESCRIPTIONS unchanged → schema-cost +0. If the fix tempts a description edit,
   stop and record it as Fog instead.

## Done when

- Ultracode gates green (`bun run check`/typecheck/test as its scripts define them);
  unit tests (a)–(c) green; the deployed wf-pause receipt (t04's sweep) shows the
  corrected line where the old snaps showed "✗ … failed".
