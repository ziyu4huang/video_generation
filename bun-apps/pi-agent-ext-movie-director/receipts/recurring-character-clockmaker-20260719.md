# Receipt — Recurring-character story: "The Clockmaker" (faceswap consistency)

**Date:** 2026-07-19 · **Effort:** `2026-07-19-recurring-character-story-faceswap`
**Ticket:** [01 — Ship the recurring-character story-video](../../.planning/2026-07-19-recurring-character-story-faceswap/tickets/01-ship-recurring-character-story.md)

## Goal

Ship a story-video with a **recurring character whose face stays consistent
across scenes** — proving the conditional `character_design` stage + flux2
`faceswap` consistency, the one capability envelope the lighthouse effort
deliberately did not exercise.

## The story

**"The Clockmaker"** (~16s): *"In a quiet shop at the edge of the old town, a
clockmaker worked by lamplight. Each gear he placed was a small promise to
tomorrow. And though the world outside rushed on, his hands kept perfect time."*

## Method — every asset through a registered provider

| Stage | Provider | Output | Wall-time |
|-------|----------|--------|-----------|
| Character ref | flux2 t2i | `char_ref.png` (1024² portrait, canonical face) | ~7s |
| 3 scene images | flux2 t2i | workbench / holding clock / window (1280×720) | ~7s ea |
| **faceswap ×3** | **flux2 `faceswap`** (`--face char_ref --input scene`) | `fs_scene1/2/3.png` (1024×1536) | **110–128s ea** |
| Narration | edge-tts | tts_edge.mp3, **13.92s** | <1s |
| Word cues | whisper | words.json, **38 per-word** | ~3s |
| Score | MLX MusicGen (`run.py music`) | music.wav, 8s, mean −22.3 dB | ~14s |
| Compose | `Story` composition | the_clockmaker.mp4, **16.04s, 1920×1080** | 5.8s |

The `character_design` → `assets` flow prescribed by `character_design.schema.json`
worked as designed: one t2i character reference, then faceswap applied per scene.

## Result — FINISHED VIDEO ✅

`output/recurring-character-story/the_clockmaker.mp4` (9.4 MB) + poster.

**Verified (not asserted):**
- **ffprobe:** h264 1920×1080 + aac, **16.043s**.
- **Audio non-silent:** `mean_volume −25.1 dB`, `max −7.0 dB` (narration + music).
- **Frames non-black** (sampled): 1.0s title (bright 0.016); 3.5/7.0/10.5s image
  scenes (bright **0.645 / 0.830 / 0.685**) — the 3 faceswap'd scenes render.

## ⚠️ Honest limitation — face consistency is user-verifiable only

**I cannot visually confirm the 3 faces look like the same person** — this
model cannot view images. What IS verified:
- faceswap ran successfully on all 3 scenes (no error; `--face char_ref`
  accepted by `FaceSwapCommand`).
- The mechanism is the documented consistency path (registry.ts: flux2
  `FaceSwapCommand` = multi-ref conditioning + BFS LoRA fused at init).

**To confirm the actual claim, compare the faces directly** — I shipped a
contact sheet alongside the video:
`output/recurring-character-story/{char_ref,fs_scene1,fs_scene2,fs_scene3}.png`.
Open those four and judge whether the keeper's face holds across scenes.

## Notes / follow-ups

- **faceswap regenerates at a default 1024×1536 (portrait)** regardless of the
  input scene's 1280×720 — it's a face-conditioned generation, not a pixel
  paste. Scene composition can drift from the t2i scene; the face is the
  invariant. Story's `object-fit: cover` keeps the (portrait) subject framed.
- **faceswap is slow** (~2 min/scene vs 7s for t2i) — multi-ref + LoRA. Budget
  ~6 min for a 3-scene consistency pass.
- `run.py music` uses `--duration` (not `--seconds`); music was called directly
  (the CLI bridge can OOM ~10s; 8s via run.py is reliable).
