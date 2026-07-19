# T1 — Fix LLM content drift in creative waypoints

type: task
claimed: (unclaimed)
blocked by: R1 — Diagnose LLM content drift

## Question

Apply the fix that R1 surfaces for the LLM content drift — the creative
waypoints (scene_plan, edit) must produce **clockmaker-themed content** that
follows the provided script/proposal inputs, not generic explainer templates.

The fix shape depends on R1's findings:
- If **prompt weakness** → strengthen `buildPrompt()` in `waypoints.ts`:
  inject "You MUST base every scene on the provided script sections. The script
  is about [title]. Do NOT produce generic/explainer content." + echo the
  script title prominently.
- If **model capacity** → switch the waypoint model to `gemma-4-26b-a4b-qat`
  (LM Studio has it) for creative stages, or make it configurable per stage.
- If **both** → do both.

### Verification

After the fix, re-run `run-waypoint {stage:"scene_plan", inputs:{script:<clockmaker>, proposal_packet:<...>}}` and confirm the output references
the clockmaker workshop / Elias / apprentice — NOT generic "presenter" /
"video generation" content.

This unblocks the automated pipeline (P2): with correct scene_plan + edit, the
downstream assets/compose stages get the right inputs.

## How to resolve

- Wait for R1's diagnosis.
- Apply the minimal fix (prompt OR model OR both).
- Verify with `run-waypoint` on scene_plan using clockmaker inputs.
- Record what was changed + the before/after model output.

## Answer

_(pending)_
