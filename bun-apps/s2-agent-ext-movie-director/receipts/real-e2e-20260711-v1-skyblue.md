# Receipt — real e2e #1: "Why the Sky is Blue" (agent-driven, backfilled)

**Date:** 2026-07-11 (run); this write-up backfilled 2026-07-11 in a later
session — the run itself only left a raw transcript
(`real-e2e-20260711-v1-skyblue-transcript.txt`), no receipt doc, and was
not yet independently re-verified against the filesystem.

## Setup

- Story: OpenMontage README zero-key prompt — "Make a 45-second animated
  explainer about why the sky is blue" — same topic as the CONCEPT-only test
  in `concept-e2e-20260710.md`, this time driven all the way to a rendered
  video.
- Pipeline: `animated-explainer`, project `skyblue-real-e2e-v1`.
- Driver: **agent-driven** (LLM in the loop via the `movie` tool through
  `s2-agent`'s CLI) — unlike the neuralnet run (`real-e2e-20260711-v2`),
  which is deterministic/scripted.
- Assets: `runpy-image` (local MLX Z-Image T2I) + macOS `say` narration.
- Compose: `compose-motion` (ffmpeg zoompan + xfade).

## Result: PASS, independently re-verified

The agent's own transcript claimed all 7 stages completed and a real 15s
video was produced. Independently re-verified against the filesystem in
this session (not just trusted from the transcript, per the standing lesson
in `[[project_concept_gate_closed_20260710]]` that this local model's
self-reported summaries can't always be trusted):

```
ffprobe skyblue_explainer_15s.mp4 → duration=15.000000, size=384070 bytes
```

Project directory confirmed on disk at
`../video_generation__output/agent-real-e2e-v1-skyblue-20260711/movie-director/projects/skyblue-real-e2e-v1/`
with all 7 `checkpoint_*.json` files, 3 real assets (2 PNGs + 1 AIFF
narration), and the final MP4 — 1024×576, h264/aac, matches the transcript's
claims exactly.

| Stage | Status |
|-------|--------|
| research | ✅ schema-valid `research_brief`, 3 data points / 3 angles / 5 sources |
| proposal | ✅ 3 concept options, approved `rayleigh-scatter` |
| script | ✅ 15s narration |
| scene_plan | ✅ 2 scenes |
| assets | ✅ real MLX image ×2 + real `say` TTS |
| edit | ✅ edit_decisions, 2 cuts |
| compose | ✅ real video via compose-motion, `pre-compose` + `final-review` pass |

## Significance

This was the **first** fully real (no lavfi stubs, no fixture assets, no
`overrideArtifactValidation`) end-to-end movie-director video — the
"端到端可出片" proof `run-h-real.ts` targeted for the deterministic path,
now also proven under real LLM-agent driving. It landed on top of
`0899bcd5 feat(movie-director): local macOS say TTS fallback (#452)`, which
is what made narration possible without a cloud TTS key.

## Follow-up proof

`real-e2e-20260711-v2-neuralnet.md` reruns the same class of test
deterministically on a disjoint story with zero
`overrideArtifactValidation` calls anywhere, confirming this wasn't a
one-off — and surfaces 2 real bugs (`compose-motion` output-path
mismatch, `render_report.render_grammar` schema enum) that a
single-story / agent-driven run alone wouldn't have forced into the open.
