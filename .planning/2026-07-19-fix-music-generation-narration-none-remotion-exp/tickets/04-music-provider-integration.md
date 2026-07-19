# 04 — Music provider integration

## Question

Wire the chosen royalty-free source (from [01](01-royalty-free-music-source.md))
into the extension as a working **`music_generation` provider** that produces a
cached local audio file `edit.audio.music.src` can point at. What's the integration
surface, end to end?

Concretely:

1. **Registry entry.** Add a `music_generation` provider to `src/registry.ts`
   (`backend: "cloud_http"`, `invoke: "fetch"`, `configured` per env/CLI presence).
   Today `music_generation` is a declared capability with **zero providers**
   (`registry.ts:20`) — this is the core fix.
2. **Bridge fetch + cache.** `src/bridge.ts` gains a `fetch`-backed music handler:
   `{mood, energy, duration}` → query the source → pick a license-clean track →
   download to the project `assets/audio/` dir → return a `kind:"audio"` artifact
   with the local path (offline-after-cache). Reuse the source's search API per
   [01](01-royalty-free-music-source.md)'s pick.
3. **Assets-encoder wiring.** `src/assets-encoder.ts` handles only
   `video_generation` + `tts` today (:21). Add the `music_generation` branch so a
   scene_plan/script's mood drives a music `generate` call and the result lands in
   `asset_manifest.audio.music`.
4. **Attribution in `publish_log`.** If the license requires attribution (CC-BY /
   Pixabay), record it — decide free-text field vs schema change (this may
   graduate the map's "attribution" fog into a sub-decision).
5. **Test + receipt.** A deterministic test (mocked fetch) + a real e2e receipt
   proving a music file reaches `compose-motion`'s `amix` and the final MP4 is no
   longer silent.

### Context (pre-gathered — don't re-investigate)

- Compose already mixes whatever `music.src` points at — `mixAudioOnto`
  (`src/compose_motion.ts:360`): music looped to duration, volume default 0.4,
  fade, `amix`'d with narration. **No compose change needed** — the contract is a
  local file path.
- `audio_mixer` (ffmpeg, `audio_processing`) IS configured (`registry.ts:347`).
- The destination fixed **royalty-free stock via network** — no Suno/Udio, no
  user-supplied file.

type: task
claimed: pi-agent
blocked by: 01 — Royalty-free music source
status: closed

## Resolution (closed 2026-07-19)

**Music provider landed + proven on real MLX. Local MusicGen via mlx-audiocraft
(CC-BY-4.0), mirroring the TTS path. Inverts [01]'s source from network stock to
local generative (user revision: "MLX + open-source + free").**

- **Model:** Meta **MusicGen** via **mlx-audiocraft**; weights **CC-BY-4.0**
  (attribution to Meta/MusicGen in publish_log; no fee, commercial OK). Default
  `facebook/musicgen-small` (override `MD_MUSICGEN_MODEL`). Stable Audio Open
  rejected (foggier license).
- **Integration (mirrors TTS):** `run.py music` command (`app/commands/music.py`)
  + `src/runpy_music.ts` adapter + `musicgen_music` registry provider
  (`invoke: "mlx:runpy-music"`) + `adaptRunPyMusic`/`realRunPyMusic` in bridge +
  `assets-encoder` `opts.music` branch. Backward-compatible (no music call when
  `opts.music` absent).
- **Setup:** `uv pip install mlx-audiocraft soundfile --python python/venv/bin/python`
  (6 packages; installed clean).
- **Real e2e proof:** `run.py music --prompt "gentle solo piano..." --duration 5`
  → valid WAV, ffprobe `pcm_s16le/32kHz/mono/5.000s`, **mean -19.9 dB (non-silent,
  passes final_review)**. First run downloads the ~1-2 GB model; warm runs skip it.
- **Tests:** `bun test` **698/0**; `check:schemas` green; typecheck clean on touched
  files. Receipt: `receipts/music-provider-mlx-musicgen-20260719.md`.
- **One open fog remains:** mood→query mapping (deriving `--prompt` from scene
  tone) — the provider takes an explicit prompt, so the gap is *derivation*, not
  generation. That stays in map Not-yet-specified.
- **Attribution:** no schema change needed (free-text field in publish_log suffices) —
  confirmed by [01]'s original resolution.
