# Receipt — Music provider: local MLX MusicGen (ticket 04)

**Date:** 2026-07-19 · **Ticket:** [04 — Music provider integration](../../.planning/2026-07-19-fix-music-generation-narration-none-remotion-exp/tickets/04-music-provider-integration.md)
**Effort:** `2026-07-19-fix-music-generation-narration-none-remotion-exp`

## Goal

Close the music gap: `music_generation` had a declared capability but **zero
providers** (the rainbows run was silent, `narration:"none"`). Wire a music SOURCE
provider that produces the audio file `edit.audio.music.src` points at — compose-
motion's `amix` pass already mixes it under the narration.

## Scope revision (honest)

[Ticket 01](../../.planning/2026-07-19-fix-music-generation-narration-none-remotion-exp/tickets/01-royalty-free-music-source.md)
resolved the source as **Pixabay stock via network**. At 04 the user revised it to
**"MLX + open-source + free"** → **local generative music**, matching the repo's
native/offline posture. This inverts the source category (network stock → local
generation) but keeps the destination intact (a working music source).

## Decision

- **Model:** Meta **MusicGen** via **mlx-audiocraft** (the full AudioCraft port for
  Apple Silicon — no CUDA). Weights **CC-BY-4.0** (attribution to Meta/MusicGen;
  commercial OK, no fee). Default `facebook/musicgen-small`; override via
  `MD_MUSICGEN_MODEL`. Stable Audio Open was the rejected alternative (foggier
  license).
- **Integration shape:** mirrors the TTS path exactly — a `run.py music` command +
  a `runpy_music.ts` bun adapter + a `music_generation` registry provider
  (`invoke: "mlx:runpy-music"`) + an `adaptRunPyMusic` bridge normalizer + an
  assets-encoder branch. Fully local after a one-time model download (no network
  egress at synth time, no API key, no cloud).

## What was built

| File | Change |
|------|--------|
| `python/.../app/commands/music.py` | NEW — mlx-audiocraft MusicGen wrapper (prompt/duration/model → wav/mp3). Guards the `mlx_audiocraft` import + model-load at runtime (mirrors tts.py's edge-tts guard). |
| `python/.../app/cli.py` | register `"music"` in `COMMAND_NAMES`. |
| `src/runpy_music.ts` | NEW — adapter (`buildMusicArgs`, `runPyMusic`, `_spawnImpl` test seam). `ok` = exit 0 AND file lands with size > 0. |
| `src/registry.ts` | `"mlx:runpy-music"` invoke + `musicgen_music` provider (native_swift, configured). |
| `src/bridge.ts` | `adaptRunPyMusic` + `realRunPyMusic` + wired into `realAdapters`. |
| `src/assets-encoder.ts` | `music_generation`/"music" on `AssetGenCall`; optional `opts.music.prompt` → one music call. Backward-compatible (no music call when absent). |
| tests | NEW `runpy_music.test.ts`; music cases in `assets-encoder.test.ts`; the 3 negative-path tests that used `music_generation` as the unwired example were updated to a synthetic unknown capability (it's the last gap that's now wired). |

## Verification (real, not asserted)

`uv pip install mlx-audiocraft soundfile` → 6 packages, clean.

Real generation via the new command:
```
run.py music --prompt "gentle solo piano, slow, melancholic" --duration 5 --output /tmp/md_music_smoke.wav
→ [music] MusicGen loading (facebook/musicgen-small, duration=5.0s)...
  [music] ✓ saved: /tmp/md_music_smoke.wav (174.59s, 5.0s of music)   exit 0
```

ffprobe on the output:
- `pcm_s16le`, **32000 Hz, mono, 5.000s**, 512 kbps — valid WAV.
- `mean_volume: -19.9 dB`, `max_volume: -6.2 dB` — **healthy, non-silent**
  (passes `final_review`'s audio_level check; edge-tts narration measured -22 dB
  for reference).

The output is exactly what compose-motion's `amix` consumes (`audio?.music?.src`).

## Test suite

- `bun test` → **698 pass / 0 fail / 5 skip** (was 697; +runpy_music tests).
- `bun run check:schemas` → green.
- `bun run typecheck` → no errors in touched files (2 pre-existing baseline errors
  in untouched files: `pi-agent-ext-ltx/shotLanguage.ts`, `movie-workflows.ts`).

## Practical notes

- **First run downloads** musicgen-small (~1-2 GB) into the HF cache; warm runs
  skip the download. The 174.59s above is cold (download + load + 5s generation).
- **Music gen is slower than TTS** — budget wall-time accordingly for long scores
  (a 30s score is proportionally longer). `--duration` controls clip length;
  compose-motion loops the track to the video duration if shorter.
- **mood→query mapping** (deriving the `--prompt` from scene tone) remains the one
  open fog on the map; the provider takes an explicit prompt for now, so the gap is
  the *derivation*, not the generation.
