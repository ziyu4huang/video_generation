# Wayfinder map: 2026-07-19-story-pipeline-automated-longform

## Destination

A **1–2 minute story-video produced automatically** by `run-pipeline story`
end-to-end (deterministic orchestrator with LLM creative waypoints), not
hand-authored. Currently the `story.yaml` manifest is schema-valid and every
provider individually works (faceswap, MusicGen, whisper, flux2 t2i, Story
compose), but the orchestrator has never driven `story` end-to-end — the
lighthouse + clockmaker videos were both manually authored via `render.ts`
scripts bypassing the pipeline.

## Notes

- **`run-pipeline`** is a deterministic orchestrator (not agent-driven): the
  driver owns stage transitions + gate-enforced checkpoints + mechanical
  generate/compose calls; **scoped LLM waypoints** produce one artifact each at
  the creative stages (research→proposal→script→scene_plan→edit). This is the
  automation mechanism — not the `agent` command (which shells out to pi-agent
  for free-form natural-language runs).
- **`generate`** already handles clip-duration chaining (I2V frames/fps) and
  TTS pacing (narration determines video length) — the pipeline's mechanical
  stages are well-documented.
- **Current scale:** lighthouse 14.5s / 3 cuts; clockmaker 16s / 5 cuts. A
  1–2 min story = 15–20 scenes = ~10× scale jump. Manual edit_decisions won't
  scale — the orchestrator MUST work.
- **faceswap** is wired (Swift-native, 1280×720 at 51s/scene) — 15–20 scenes ×
  ~1 min = 15–20 min batch, acceptable.
- **MusicGen** at 8s is proven stable (bridge ≤8s, direct run.py ≤8s). For
  1–2 min: 8s clip looped 8–15× (compose-motion's mixAudioOnto already loops).

## Decisions so far

- [R1 — Probe orchestrator viability](tickets/R1-probe-orchestrator-viability.md) — **closed.**
  Orchestrator functional (init-project/nest-stage work); LM Studio confirmed
  running with gemma-4-12b-qat. Two concrete bugs found and fixed in
  [T1](tickets/T1-fix-waypoint-bugs.md): `--no-tools` argv corruption +
  missing markdown fence stripping before JSON.parse. After restart, proposal
  should complete.
- [T1 — Fix waypoint bugs](tickets/T1-fix-waypoint-bugs.md) — **closed.**
  Both bugs fixed; `bun test src/waypoints.test.ts` → 8/0 pass.

## Not yet specified

<!-- all core decisions resolved — effort is closed -->

### Post-effort notes

- LLM creative waypoints work but content quality varies — scene_plan and edit
  produced generic explainer content instead of following the clockmaker
  script. Prompt engineering or model upgrade (gemma-4-26b) would help.
- LM Studio config must live in `~/.pi/agent/models.json` — settings.json
  provider change without models.json won't resolve.
- compose-motion handles still-image slideshows correctly but lacks
  transitions/Ken Burns without richer edit_decisions.
- MusicGen 8s → 90s loop is clean but repetitive; multi-clip mood-varied music
  would be better for a polished production.

## Out of scope

- Cloud video generation (Kling, Veo) — native-MLX only.
- SVG rig character animation.
- Real-time/interactive stories.
