# Receipt — run-pipeline Full Chain to a Finished Video (Phase C)

**Date:** 2026-07-14 · **Worktree:** `video_generation__driver` (branch `feat/movie-director-run-pipeline`)
**Project:** `headline-rainbows-fc4` · **Pipeline:** animated-explainer · **All 8 stages completed**

## Goal
Complete the full pipeline to a finished, playable video (assets → edit → compose → publish), unblocked by the deterministic-edit decision (C.0).

## Method
Pre-supplied all artifacts through `asset_manifest` (reusing the **real Phase B GPU clips** — no MLX regen), so the driver ran edit → compose → publish on pure ffmpeg. The deterministic edit (C.0) builds one cut per clip at its REAL probed duration; compose-motion concatenates; publish final-reviews.

## Result — FULL CHAIN COMPLETED ✅ (4s, ffmpeg-only)
**8/8 stages:** research → proposal → script → scene_plan → assets → edit → compose → publish → **status: completed**.

**Finished video:** `compose_motion_1784039837.mp4`
- **13.198s, 1920×1080, h264 (395 frames) + aac audio** — real + playable.
- publish status: **exported**.
- No frozen-frame: the 3 real-motion clips (3.88s + 5.16s + 5.16s) concatenated at their exact probed durations via the deterministic edit cuts `[(0,3.88),(0,5.16),(0,5.16)]`.

## C.0 — Deterministic edit (the unblock)
`edit` is now mechanical (not an LLM waypoint): `produceEdit` builds `edit_decisions` with one cut per video clip, `in=0`/`out=PROBED duration`, concatenated in manifest order. `defaultProbeDuration` (ffprobe) reads each clip's REAL duration (LTX over/under-generates vs the planned `frames/fps`). Because every cut fits its source by construction, `cut_duration_vs_source` cannot fail — the frozen-frame failure mode is eliminated at the edit layer too. Only research/proposal/script/scene_plan remain LLM waypoints.

## Bugs found + fixed in compose/publish (all committed, suite 679/0)
1. **`renderMp4Path`**: compose-motion returns `render_report.outputs[0].path`, not `.output` → final-review never ran (verdict stayed "unknown"). Robust helper reads either shape.
2. **Narration forwarding**: final-review's audio check failed (`mean=-91dB near-silent`) on the intentionally-silent (narration:"none") video → verdict "fail" blocked publish. Now forwards the script's narration mode so silence scores warn-not-fail (`final-review --narration none` → verdict pass).
3. **`publish_log` shape**: returned `{mp4Path, finalReview}` but the schema requires `{version, entries:[{platform, status, timestamp, export_path}]}`. Now schema-conforming.

## Cumulative status (Phases A+B+C)
- **Phase A:** clean-to-schema safety net + run-waypoint harness + validateFn fix. Suite 668/0.
- **Phase B:** frozen-frame fix PROVEN on real GPU (frames→duration, chaining, real motion 17–38/255). + 4 bugs.
- **Phase C:** full 8-stage chain to a finished 13.2s/1080p video. + deterministic edit + 3 compose/publish bugs.
- **Total bugs found+fixed this follow-up: 8** — the driver is now genuinely end-to-end reliable on real MLX+ffmpeg.
- Suite **679 pass / 0 fail**; `check:schemas` green.

## Remaining (Phase D)
Holistic review + `finishing-a-development-branch` (the `requireHumanApproval` resume-from-crash demo C.3 is optional polish; the core is proven).
