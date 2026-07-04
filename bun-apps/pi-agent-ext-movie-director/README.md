# pi-agent-ext-movie-director

The movie-director **orchestration extension** — an instruction-driven (agent-first)
video production pipeline, rewritten from [OpenMontage](https://github.com/jieg9341-lab/ComfyUI-Krea2-StyleTransfer-adjacent) (Python) into pure Bun + Swift-MLX-native.

> Iteration 1 (foundation): pipeline manifest loader, gate-enforced checkpoints,
> artifact schema validation, budget tracker, provider registry. Media generation
> bridges (native directors + ffmpeg + cloud) land in later iterations.

## Why

OpenMontage is **agent-first**: Python is only tools + persistence; the agent
(reading YAML pipeline manifests + MD stage-director skills) IS the orchestrator.
`pi-agent` is already an agent runtime — so the rewrite is a 1:1 fit: the
orchestration becomes a Bun pi-extension, and the Python tools become the repo's
existing native Swift/MLX directors (`krea2-image-director`, `flux2-image-director`,
`ltx-video-director`) + ffmpeg/cloud bridges.

Pipeline: `idea/research → proposal → script → scene_plan → assets → edit → compose → publish`,
with 7 canonical artifacts, style playbooks, an advisory reviewer, checkpoint gates
with human-approval policy, and a cost tracker. See `output/new-goal-20260704-2238.md`
for the full long-term goal + roadmap.

## What's here (iteration 1)

```
extensions/pi-movie-director.ts    # ONE `movie` dispatcher tool (12 commands)
src/pipeline.ts                    # manifest loader + stage accessors (port of lib/pipeline_loader.py)
src/checkpoint.ts                  # gate-enforced checkpoint writer/reader (port of lib/checkpoint.py)
src/schema.ts                      # ajv validation over bundled OpenMontage schemas
src/cost.ts                        # budget tracker: estimate → reserve → reconcile (port of tools/cost_tracker.py)
src/registry.ts                    # explicit provider registry + provider-menu rollup
src/paths.ts                       # data dir + project workspace resolution
data/                              # manifests + schemas + playbooks (copied verbatim, MIT)
```

### The gate (the binding rule)
`write-checkpoint` with `status="completed"` on a stage whose manifest
`human_approval_default=true` is **rejected** unless `humanApproved=true`. This is
the one hard enforcement — the agent cannot silently skip a human-approval gate.
Match-checked against `talking-head` (idea/script/scene_plan/assets/publish gated;
edit/compose not).

## Use

```bash
bun install                                # at repo root (workspace member)
bun test                                   # in this package
bun run check:schemas                      # validate every bundled manifest + schema
```

Load the extension (source mode):
```bash
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-movie-director/extensions/pi-movie-director.ts \
  -p "run preflight, then plan a 30s animated-explainer"
```

The `movie` tool's commands: `preflight`, `pipeline-list`, `pipeline-show`,
`init-project`, `next-stage`, `write-checkpoint`, `read-checkpoint`,
`validate-artifact`, `cost-estimate`, `cost-reserve`, `cost-reconcile`,
`cost-snapshot`. See the tool description for the per-command options.

## Roadmap (later iterations)

2. Native director bridge — registry → `krea2`/`flux2`/`ltx` via the shared
   `ToolResult` JSON contract; `image`/`video` selectors wire the `assets` stage.
3. FFmpeg + cloud HTTP providers (audio_mixer, color_grade, video_stitch,
   subtitle_gen, TTS/music/stock via `fetch`).
4. Compose (templated) — Remotion as a Node subprocess; `final_review` self-checks.
5. First end-to-end pipeline (`animated-explainer`) → a shipped video.
6. Native gap closure — Whisper (captions), CLIP, upscale.
7. More pipelines + the native atelier compose arc.

## Status
Iteration 1 of a multi-iteration rewrite. Foundation only — no media calls yet.
