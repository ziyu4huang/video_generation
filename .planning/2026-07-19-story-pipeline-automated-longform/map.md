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

1. **Post-restart verification (R2).** After session restart (cached imports
   pick up the T1 fixes), confirm `run-pipeline story` completes proposal →
   script → ... → publish. Expected to work now — the model produces valid JSON
   (fence-stripping handles the wrapper), and `--no-tools` is correct.
2. **Story content structure.** What narrative fills 1–2 min? A traditional
   3-act structure? Multiple vignettes? The orchestrator + model will generate
   this — the remaining open question is whether the generated content hits the
   90s target duration.
3. **Music scaling.** 8s MusicGen clip looped to 1–2 min — does the loop
   sound repetitive? Or generate multiple clips with different prompts per
   scene mood?
4. **Faceswap batch scaling.** 15–20 scenes × ~1 min each = 15–20 min —
   acceptable for a batch run. The assets encoder's proactive plan already
   handles I2V chaining; faceswap just needs to be woven in.

## Out of scope

- Cloud video generation (Kling, Veo) — native-MLX only.
- SVG rig character animation.
- Real-time/interactive stories.
