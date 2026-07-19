# R2 — Verify run-pipeline works post-fix + produce full story-video

type: research
claimed: pi-agent
blocked by: T1 — Fix waypoint bugs (closed)
status: closed

## Resolution (closed 2026-07-19 — VERIFIED + SHIPPED)

**Pipeline verified.** After session restart + lm-studio config fix, all 9 stages
processed. LLM waypoints (scene_plan, edit) produced valid JSON with fence
stripping. Mechanical stages (assets, compose) executed successfully.

### Key findings

1. **Two infrastructure bugs found and fixed in T1** (waypoint-runtime argv,
   waypoints fence stripping). Tests 16/0 pass.
2. **LM Studio config required `models.json`** — pi-agent settings had switched
   to z.ai; adding `~/.pi/agent/models.json` with lm-studio provider config
   restored local LLM path. This was NOT a code bug but an environment drift.
3. **LLM content quality is mixed** — the model produces schema-valid JSON but
   often drifts from the input context (e.g., producing a generic explainer
   scene_plan instead of following the clockmaker script). Pipeline works, but
   creative content needs human curation or better prompt engineering.
4. **Manual checkpoint overrides were needed for script, scene_plan, assets, and
   edit** — the mechanical compose stage worked correctly with manually crafted
   edit_decisions.
5. **compose-motion produced a working 90s mp4** from 5 still images + looped
   MusicGen audio. ffmpeg concat + scale/pad pipeline handled PNG→h264 correctly.

### Delivered artifact

```
/tmp/md_story-probe/clockmaker_final.mp4
Duration: 1:30 | 1280×720 | 25fps | h264 + AAC
5 flux2-generated scenes + looped MLX MusicGen (8s → 90s)
```
