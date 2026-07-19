# Receipt — Story-video example: "The Lighthouse Keeper" (ticket 08, the destination)

**Date:** 2026-07-19 · **Ticket:** [08 — Ship the story-video example](../../.planning/2026-07-19-fix-music-generation-narration-none-remotion-exp/tickets/08-ship-the-story-video-example.md)
**Effort:** `2026-07-19-fix-music-generation-narration-none-remotion-exp` · **Destination reached.**

## Goal

Ship a finished, original story-video produced end-to-end by movie-director,
demonstrating the same capability envelope as OpenMontage's story samples — and
closing all three named gaps together (music, richer compose, story pipeline).

## The story

**"The Lighthouse Keeper"** — a ~14.5s atmospheric short:
*"On the edge of a restless sea stood an old lighthouse. Each night the keeper
lit the lamp, and the light reached out across the dark water. No storm could
pass unseen."*

## Method — every asset through a registered provider

| Stage | Provider (invoke) | Output | Wall-time |
|-------|-------------------|--------|-----------|
| Scene images (×3) | flux2 (`swift:flux2`) | lighthouse / keeper / beam PNGs (1280×720) | ~7s each |
| Narration | edge-tts (`bun:tts-native`) | tts_edge.mp3, **11.35s**, en-US-AriaNeural | <1s |
| Score | **MusicGen (`mlx:runpy-music`)** | music.wav, 8s, **local MLX, CC-BY-4.0** | ~14s (cached model) |
| Word cues | whisper (`bun:whisper`) | words.json, **32 per-word timestamps** | ~3s |
| Compose | **Story composition (`compose:remotion`)** | lighthouse_keeper.mp4, **14.55s, 1920×1080** | 5.7s |

The edit_decisions drove the **`Story` composition** (ticket 06): 5 cuts (2 text
title/beats + 3 image scenes w/ ken-burns/zoom/pan) each with a **particle
overlay** (sparkle/firefly/petal), **TikTok-style word-pop captions** from the 32
word cues, narration + looped music (volume 0.22, ducked under narration).

> **CLI gotcha discovered + worked around:** the movie CLI's `--options` nests
> provider options under `{"options":{...}}` (flat `{"prompt":...}` silently
> drops them — that produced a 1.8s truncated narration + a "Undefined."
> whisper result on the first pass). Re-running with the nested shape fixed
> both. Worth a doc note (the README's one example does show the nesting, but
> it's easy to miss).

## Result — FINISHED VIDEO ✅

`output/story-example/lighthouse_keeper.mp4` (8.48 MB) + `poster_lighthouse.png`.

**Verified (not asserted):**
- **ffprobe:** h264 1920×1080 + aac 48kHz stereo, **14.549s**.
- **Audio non-silent:** `mean_volume -25.7 dB`, `max -5.8 dB` — narration + music
  mixed (the rainbows run was silent; this one has a real soundtrack).
- **Frames non-black + real content** (sampled):
  - 1.0s (title card + sparkle): mean 43, bright 0.018 (text on dark)
  - 4.0s (lighthouse + fireflies): mean 59, bright **0.570** (image fills frame)
  - 7.0s (keeper): mean 80, bright **0.608**
  - 10.0s (beam): mean 82, bright **0.583**
  - Image scenes' high bright fractions confirm the flux2 images render through
    Story's motion + particle layers, not blank.

## Fog retired by this run

- **Character consistency** (was the map's #1 fog): this story has no recurring
  character, so the conditional `character_design` stage correctly stayed
  inactive — the mechanism (03/07) is in place for stories that need it; the
  verdict here is "not exercised, by design."
- **Mood→query mapping:** the music `--prompt` was authored explicitly from the
  scene mood ("gentle solo piano, melancholic, slow, reflective"). The provider
  takes an explicit prompt; derivation remains a thin driver/agent wire, not a
  blocker.
- **Example motion source:** resolved = **flux2 images + Remotion motion**
  (Candyland-style), exercising the Story composition's ken-burns/zoom/pan.

## Cumulative status (whole effort)

All 8 tickets closed: 01✅ 02✅ 03✅ 04✅ 05✅ 06✅ 07✅ 08✅. The three named gaps
(music provider, richer Remotion compose, story pipeline) are closed AND proven
together in one shipped video. `bun test` 700/0; `check:schemas` green.
