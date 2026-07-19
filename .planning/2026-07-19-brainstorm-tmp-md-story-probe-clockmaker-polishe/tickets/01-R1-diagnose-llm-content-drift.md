# R1 — Diagnose LLM content drift in creative waypoints

type: research
claimed: (unclaimed)
blocked by: (none)

## Question

In the R2 probe of the previous effort, the `scene_plan` and `edit` LLM
waypoints produced a **generic "revolutionizing video generation" explainer**
instead of following the clockmaker script that was passed as input. The
infrastructure works (valid JSON, fence-stripping fixed), but the model
ignored the input content.

This is the **root blocker** for the automated pipeline: if the LLM can't
produce clockmaker-themed scene_plan/edit artifacts, every downstream stage
gets wrong content.

Diagnose WHY the model drifted. Three hypotheses to test:

1. **Prompt weakness** — `buildPrompt()` in `waypoints.ts` passes inputs as a
   JSON blob under "Inputs:" but the system prompt doesn't emphasize "use the
   provided script/proposal content verbatim." The model may treat the inputs
   as optional context.
2. **Model capacity** — `gemma-4-12b-qat` (12B, quantized) may be too small to
   hold the script content + schema constraints simultaneously and defaults to
   its training distribution (explainer templates). Would `gemma-4-26b` do
   better?
3. **Input shape** — is the script actually reaching the model? Check the
   exact prompt string sent to `runBoundedSession` for scene_plan.

## How to resolve

- Read `buildPrompt()` + `runCompletionWaypoint()` in `waypoints.ts` — trace
  the exact prompt string for the scene_plan stage.
- Run `run-waypoint {stage:"scene_plan", inputs:{script:<clockmaker script>, proposal_packet:<...>}}` with `--model google/gemma-4-12b-qat` and capture the
  raw model output. Does the clockmaker content appear in the model's thinking?
- Retry with `google/gemma-4-26b-a4b-qat` (LM Studio has it loaded) — does the
  larger model follow the script?
- Surface the fact: is this fixable by prompt engineering, model upgrade, or
  both?

## Answer

_(pending)_
