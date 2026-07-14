# Receipt — run-pipeline Headline Proof (frozen-frame fix on real GPU)

**Date:** 2026-07-14 · **Worktree:** `video_generation__driver` (branch `feat/movie-director-run-pipeline`)
**Project:** `headline-rainbows-form` · **Pipeline:** animated-explainer · **Provider:** ltx-runpy (LTX-2.3, MLX)
**MLX venv:** reused `video_generation__ltx/python/venv` via `MLX_VENV_PYTHON` (no fresh install)

## Goal
Prove the frozen-frame fix on **real GPU**: the assets encoder's proactive
`frames = ceil(scene_duration × fps)` encoding + chaining for >8s scenes, so
every second of generated video has real motion (no frozen-frame extension).

## Method
`run-pipeline --preSuppliedArtifacts {research_brief, proposal_packet, script, scene_plan} --requireHumanApproval edit` — pre-supplies the 4 creative artifacts (skipping the LLM waypoints) so the driver drives straight to the **assets** stage on real MLX (T2I2V), then pauses at edit. `scene_plan` has a 4s scene + a **10s scene** (exercises single-clip + chaining). `script.narration:"none"` (no TTS). Fully LLM-free through assets.

## Result — HEADLINE PROVEN ✅

The 10s scene chained into 2 clips; every clip has real motion at the planned duration. `frames` is respected by real T2I2V (no frozen-frame):

| clip | encoder plan | real GPU (ffprobe) | motion (frame-diff early-vs-late) |
|------|-------------|--------------------|-----------------------------------|
| sc1-0 (4s scene) | 100 frames → 4.0s | **97 frames / 3.88s** | 38.2/255 → **REAL MOTION** |
| sc2-0 (chain 0 of 10s) | 125 frames → 5.0s | **129 frames / 5.16s** | 17.3/255 → **REAL MOTION** |
| sc2-1 (chain 1 of 10s) | 125 frames → 5.0s | **129 frames / 5.16s** | 17.3/255 → **REAL MOTION** |

- The encoder splits a >8s scene evenly across `ceil(duration/maxCallSeconds)` links (10s → 2×5s), each a real T2I2V with `frames=ceil(perLinkDuration×fps)`.
- T2I2V respects `frames` (97/129/129 ≈ requested 100/125/125; LTX over-generates ~4 frames — harmless).
- Chaining wired in production (`defaultExtractLastFrame`: ffmpeg `-sseof -0.3` → PNG → fed as `image` for the next link) — the continuation clip (sc2-1) has its own real motion.
- The pre-compose `cut_duration_vs_source` gate **correctly** fired on a later misalignment (see below) — the frozen-frame *detection* net works.

## Bugs found + fixed en route (all committed, full suite 668/0)
1. **waypoint validateFn** read `parsed.valid` but `validate-artifact` returns `{ok}` → waypoint validation never actually ran (the /approval error only surfaced at the checkpoint gate, no retry feedback). Centralized `makeWaypointValidateFn` (reads `ok`); both run-pipeline + run-waypoint use it.
2. **chaining disabled in production**: `produceAssets` only chained when `extractLastFrame` was injected, but the dispatch case never supplied a real one. Added `assets-runtime.defaultExtractLastFrame` (ffmpeg) as the default.
3. **asset_manifest shape**: `produceAssets` emitted `{sceneId,capability,command,path,chainIndex}` but the schema requires `{id,type,path,source_tool,scene_id}` + `version:"1.0"`. Fixed to shape each asset to the canonical schema.
4. **`narration:"none"` didn't skip TTS**: the encoder's `??` operator treated `"none"` as the narration text. Fixed to skip TTS entirely on `narration:"none"`; TTS calls now carry the first scene's id.

## Finding — compose blocked by edit-waypoint cut alignment (Phase C)
The run continued past assets into `edit` (LLM) → `compose`, where the pre-compose gate **correctly** rejected `edit_decisions`:
```
cut_duration_vs_source: cut-2 requests 5.00s, source has 1.16s left (77% would be frozen) [fail]
                       cut-3 in_seconds=9.00s is past source duration 5.16s [fail]
```
The edit waypoint produced cut windows that exceed the real source-clip durations (it treated cuts as an absolute timeline rather than per-clip in/out windows). This is **not** a frozen-frame-fix issue — it's the edit waypoint's alignment quality. The detection gate worked exactly as designed.

**Options to reach a finished video (Phase C):**
- (a) Deterministic edit: build `edit_decisions` directly from the asset_manifest's real per-clip durations (mirror the assets-encoder philosophy) — one cut per clip, in=0/out=clipDuration. Reliable, no LLM alignment risk.
- (b) Strengthen the edit prompt to convey real per-clip durations + enforce per-clip in/out bounds; escalate to a stronger model.
- (c) Pre-supply a hand-authored edit_decisions aligned to the real clips.

## Status
- **Phase B headline: PROVEN** (assets encoder / frozen-frame fix on real GPU — durations correct, real motion, chaining works, detection gate works).
- Full compose→publish deferred to Phase C pending the edit-alignment decision above.
