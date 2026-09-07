# t01 — live pause/resume receipt leg (wf-pause scenario)

## Verified findings

- `tui-drive.ts` `scenarioWorkflow` (scripts/tui-drive.ts:631–716) drives
  start → `/subagents` → x-abort only. No pause gesture anywhere.
- Pause UX exists: `workflow-ui.ts:521` `case "p": return { type: "pause" }`,
  handler `:626–628` `manager.pause(id)`; footer hint `:470` ("p pause · x
  stop · r restart · s save").
- Arc-10 landed `paused` as a live status: `workflow-manager.ts` pause/resume
  stamp the shared registry; `task-panel.ts:261` renders `⏸` for paused rows.
- Scenario type union at tui-drive.ts:59 — add `"wf-pause"`.

## Implementation

1. New `scenarioWfPause()` in `bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts`
   (clone the scenarioWorkflow skeleton):
   - Same bg workflow script (`wf_pause` name; agent b sleeps so there is a
     window to pause in — reuse the `sleep 8` second agent).
   - LATCH child evidence first: wait for `/\d\/2 agents|◆ wf_pause/`
     (identical to scenarioWorkflow's latch) before ANY gesture.
   - Gesture 1: `/workflows` → Enter → wait for run row → press `p` →
     wall-clock sleep ≥1200ms (learning #3: fresh dialogs eat first
     keypress — pace with REAL sleeps, never byte-silence).
   - Latch `pausedRow`: panel/row shows `⏸` or `paused` (task-panel or
     navigator), AND the shared `/subagents` wf row reads paused (open
     `/subagents` in a second gesture) — this is the arc-10 change-channel
     payoff with NO reopen (stay in viewer; repaint must arrive).
   - Gesture 2: `r` is restart — use `/workflows` + `p`-toggle is pause-only;
     resume via the navigator's resume affordance if present, else
     `/workflows resume <id>` typed command (workflow-commands.ts:24 — the
     command form is the documented CLI face). Latch `resumedRow`: row back
     to `◆`/running, then final `WF-OK`-style completion marker.
2. Register in the scenario union + arg help (line 59, 89).
3. NO product-code changes expected. If the `/subagents` wf row does NOT
   repaint to paused without reopen, fix the viewer's change-channel
   invalidate path for paused status (in-scope; cite the failing snap).

## Tests + receipt design

- Unit: none new (product unchanged) — unless the repaint fix lands, then one
  viewer test mirroring `tests/workflow-in-flight-registry.test.ts` shape.
- Receipt (source leg): `--scenario wf-pause` on a fresh scratch session dir;
  checks latched INSIDE the polling loop: `wfRow`, `pausedRow`,
  `resumedRow`, `completed`, all gated on child evidence; no reopen kicks;
  every check snapshotted (`snap(..., true)`).
- Receipt (deployed leg): same command against the redeployed tree.
- Never delete a failing receipt (evidence trail).

## Risks / descope

- Timing window: if the workflow finishes before `p` lands, lengthen agent
  b's sleep; keep timeout generous (default `--timeout`).
- The resume keymap on the navigator may be `r restart`-conflicting — the
  typed `/workflows resume <id>` fallback is already documented behavior.
