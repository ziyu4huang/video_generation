# Ambient-sound (`ambient_sound`) capability verification — 2026-07-10

## Why this exists

`docs/openmontage-capability-matrix.md` tracks OpenMontage's premium-provider
`supports` flags against this repo's native MLX/LTX stack. Rescanning all
provider `supports` dicts (`../OpenMontage/tools/video/*.py`, read-only) on
2026-07-10 turned up one flag never previously tracked here: **`ambient_sound`**
(Veo-only in OpenMontage's provider set). Architecture research suggested this
repo's default `video generate` T2V/I2V path already generates a native audio
track jointly with video — even with no `--audio` reference input — because
`ltx_pipelines_mlx.TI2VidTwoStagesPipeline.generate_two_stage()` always produces
both `video_latent` and `audio_latent` from the text prompt (`ti2vid_two_stages.py`
lines ~354-587: `_encode_text_with_negative`, `audio_state`, `audio_latent` are
unconditional, not gated on an audio input). This doc verifies that claim with a
real run rather than trusting the architecture read alone.

## Bug found + fixed on the way

Running `video generate --self-test rainy-street` first hit a pre-existing
`RecursionError`: `_run_generate_self_test()` (`app/commands/video-generate.py`)
clones `args` via `copy.copy()` but never clears the clone's `self_test` field,
so the recursive `_run_generate_inner(test_args)` call sees `self_test` still
set and calls `_run_generate_self_test()` again — infinite recursion. This
broke `--self-test` for **every** video-generate test prompt, not just this
one. Fixed by setting `test_args.self_test = None` right after the clone
(`app/commands/video-generate.py`, `_run_generate_self_test`).

## Test setup

Used the existing `rainy-street` test prompt (`app/test_prompts_video.py`) —
chosen because it is a **pure ambient-soundscape prompt with zero dialogue**:
"steady rainfall hitting different surfaces... neon signs hum and crackle...
distant traffic rumble... wet brakes hiss..." — an ideal isolate for this
question, already in the repo, no new prompt authoring needed.

```
python/venv/bin/python python/mlx-movie-director/run.py video generate --self-test rainy-street
```

704×512, 65 frames @ 24fps (2.71s), T2V mode (no `--audio` input, no
`--input-image`), default dev transformer, seed 42.

## Audio analysis

Extracted the AAC audio track to 16kHz mono PCM and measured:

| Metric | Value | Interpretation |
|---|---|---|
| Overall RMS | 0.241 | Well above silence/noise-floor (silence would read ~0.00x) |
| Peak | 0.914 | Full dynamic range used, not clipped-flat |
| Per-100ms-frame RMS | min 0.216 / max 0.280, std 0.0138 | Low variance, **continuous texture** — consistent with "steady rainfall" (a continuous ambient bed), not sparse discrete SFX bursts or silence-punctuated speech |
| Spectral centroid | 2390 Hz | Mid-range weighted, consistent with a mixed rain/rumble/hiss soundscape rather than a pure tone |
| Low-rumble energy (20-200Hz) | 37.7% | Matches prompt's "traffic rumble," "engine rumble" |
| Mid energy (200-2000Hz) | 49.2% | Matches "rain patter," general ambient bed |
| Hiss/HF energy (2000-8000Hz) | 13.0% | Matches "hiss of raindrops," "steam hissing," "electrical buzz" |

## Verdict: **positive** — `ambient_sound` is already covered, no new engine work needed

The audio is broadband, continuous, and full-dynamic-range — not silence, not
a flat tone, not a noise-floor artifact. Energy is distributed across three
bands in a way that plausibly matches the prompt's described rain/rumble/hiss
mix rather than concentrating in one narrow band (which would suggest a single
dominant artifact rather than a composed soundscape). Combined with the
architecture read (audio generation is unconditional in the T2V/I2V pipeline,
not gated on an `--audio` input), this is enough evidence to mark `ambient_sound`
as **covered by the existing `native_audio` path** — the same `video generate
--prompt "<ambient-rich description>"` call already used for `native_audio`,
just with an ambient-focused rather than dialogue-focused prompt.

**Caveat**: this is a spectral/statistical read, not a perceptual/human-judgment
listening test (no audio playback available in this environment) and not a
comparison against a silence or single-tone negative control from this same
session. The measured signature (continuous, broadband, prompt-consistent band
energy) is the right shape for ambient soundscape and is inconsistent with
silence or a degenerate artifact, but a human listening pass would be the
stronger confirmation if/when this capability becomes load-bearing for a real
integration decision.

## Files

- Bug fix: `python/mlx-movie-director/app/commands/video-generate.py`
- Generated clip: `output_20260710_053502.mp4` (gitignored output dir, not
  committed — reproducible via the command above, seed 42)
