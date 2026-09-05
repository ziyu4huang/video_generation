# FLUX² Director — Bun web UI over swift/flux2-image-director (t2i quality enhancement)

- **Date:** 2026-09-03
- **Status:** implemented (same session)
- **Packages:** `bun-apps/gui-flux2-director` (new), `swift/flux2-image-director` (enhanced)

## Goal

Generate good-quality images with the FLUX model (Flux2 Klein 9B, native Swift
MLX) through an expert Bun web UI, instead of hand-assembling `flux2` CLI
flags. The existing `gui-movie-director` drives the Python `run.py` pipeline;
nothing drove the Swift CLI's text-to-image path.

## Swift enhancement (`flux2 t2i`)

`T2ICommand.swift` gains what `scene` already had, so plain text-to-image can
carry the repo's quality stack:

- `--lora` / `--lora-scale` (repeatable, rank-stacked via
  `Flux2LoRALoaderCLI.loadMerged`; RunConfig records `lora_paths` +
  `lora_scales`).
- `--strict-gate` (ImageGate noise/blank/NaN check before save; verdict prints
  either way).
- **Sidecar-drift fix (pre-existing bug):** `writeArtifacts` used to re-call
  `OutputPathResolver.makePaths`, which regenerates the `output_YYYYMMDD_HHMMSS`
  base name — whenever the PNG save crossed a second boundary the
  `.run.json`/`.manifest.json` landed under `output_…+1s` and the PNG lost its
  audit sidecars (reproduced 2026-09-03: `output_20260903_203012.png` with
  sidecars at `output_20260903_203013.*`). Paths are now resolved once in
  `run()` and passed into `writeArtifacts` (same shape `scene` already used).

## Web UI (`bun-apps/gui-flux2-director`)

Bun.serve + Bun.build-bundled React 19 frontend; no WebSocket — progress rides
one SSE stream per job.

- **Quality presets:** Draft (4 steps) / Balanced (6) / Quality (8 steps +
  Realism & Detail LoRA stack + auto 4× RealPLKSR upscale chained after t2i).
- **LoRA stack builder:** inventory from `mlx-models/lora/`
  (weight-bearing dirs only), per-LoRA scale sliders, one-click stacks
  (Realism & Detail; the README's scene-tuned Full 12-stack), filtered to
  what exists on disk.
- **Expert sampling controls:** steps, CFG (1.0 = distilled-recommended),
  UInt64 seed as string (dice randomize), transformer picker, 16-px-aligned
  size presets.
- **Job model:** single-flight (409 while a job runs — the 9B transformer owns
  the GPU); stage parse from CLI output (queued → loading → generating → done);
  output path parsed from the ✅ echo; cancel = SIGTERM the child tree
  (reuses `s2-agent-ext-flux2`'s `invoke.ts`).
- **Gallery:** read-only projection of the `.run.json`/`.manifest.json`
  sidecars, newest first — every CLI generation (any command) shows up.
- **Path safety:** client paths must resolve inside the output dir; model
  names must be bare path components (the CLI joins them onto models roots
  without sanitization).
- **Preflight:** `/api/health` reports `mlx.metallib` presence; job start
  fails fast with the `build-metallib.sh` remedy instead of the cryptic
  "Failed to load the default metallib" exit 255.

## Verified (2026-09-03, this machine)

- `flux2 t2i --lora details-9b --lora qualitya --strict-gate`: merged 144
  adapters, gate PASS, 256²/4steps in 4.8 s.
- UI-driven Quality-preset run: 1024²/8steps + 4-LoRA stack → auto 4× upscale
  → 4096² `.4x.png` (26 MB) end-to-end from the browser; job card showed
  Diffusing → done; gallery refreshed with the `.4x` thumb.
- Sidecar trio glued to the PNG after the fix (`output_20260903_203537.*`).
- Gates: `gui-flux2-director` `bun run test` (typecheck + 32 tests),
  `bun-apps` `test:deps` + `test:scripts`; visual pass on rendered pages.

## Story mode with voice (added same day, `swift/ltx-video-director` integration)

Extends the studio with a **Story** tab backed by a three-stage pipeline
(`lib/story.ts`), one job, single-flight like the rest:

1. **Keyframes** — one `flux2 t2i` per scene (shared cinematic style prefix,
   seed family `seed+i`), the same quality t2i path as Image mode.
2. **Grid** — ffmpeg `hstack` stitches panels into the shared NxN grid image
   the storyboard relay pins identity with.
3. **Render** — `ltx-video native-storyboard` (hard-cut relay via
   `@repo/s2-agent-ext-ltx`'s `ensureBinary`): per segment, T2I frame 0 +
   grid panel pin (0.525) + LTX-2.3 distilled I2V **with joint audio-video
   generation** — scene prompts carry voice cues (rain, meow, wind) so each
   clip ships its own synchronized soundtrack; segments concatenate to one
   H.264+AAC mp4. The UI shows stage labels Keyframing → Stitching grid →
   Rendering video + voice, plays the final mp4 (`/api/media`), keeps a
   past-stories strip (`GET /api/story`), and the newest run auto-loads when
   entering the tab.

Default story (decided for the user): **"Miko in the Lighthouse"** — 4
scenes of a ginger cat through a storm at a lighthouse, ending at dawn.

**D4 — storyboard config over raw flags.** `native-storyboard`'s JSON config
(reused verbatim) is the API surface; the server writes
`OUTPUT_DIR/story/<stamp>_s<seed>/storyboard.json` + `story.json` sidecar so
runs are listable and re-openable.

**Verified (2026-09-03):** probe 2×2s story in 4.7 min; full 4×2s "Miko"
story in ~9 min — 8.17s mp4, AAC on every segment (max volume −5.4…−22.2
dB), frames match all four prompts with a consistent cat (ffprobe +
extracted contact sheet). Judge pass on the Story-tab render.

## Speed pass (2026-09-04)

Measured on this machine (128 GB RAM, internal SSD, weights 8-bit: 9 GB
transformer + 7.5 GB qwen3-8b encoder): a 1024² 8-step t2i spends ~0.5 s in
process spawn + model load (mmap stays page-cache warm) and ~17 s GPU-bound
in diffusion (~2.1 s/step; step 1 pays the weight page-in). So the levers
are step count and visibility, not process reuse:

- **Quality preset 8 → 6 steps**: same-seed A/B showed 6 ≡ 8 visually on the
  distilled Klein (4 is measurably softer); −25% wall time. Auto-4× detail
  pass unchanged.
- **Per-step telemetry**: `Flux2T2IPipeline` now prints
  `   step k/N  (x.xs/step)` per denoise step + a `vae decode...` marker.
  The UI parses these from the SSE log → job-card progress bar, step
  counter, live elapsed, and ETA (verified mid-run: bar 33% at step 2/6,
  eta ~13 s). Finished jobs show total wall time.

## Decisions

- **D1 — new package, not a gui-movie-director view.** Different backend
  (Swift CLI vs Python run.py), single-purpose expert screen; keeps the
  existing GUI's schema-sync machinery untouched.
- **D2 — t2i-first.** The generator ask is text→image; scene/swap/expand stay
  CLI/agent-facing. The job/upscale/gallery layer is command-agnostic, so
  adding modes later is incremental.
- **D3 — reuse `invoke.ts` from s2-agent-ext-flux2** (declared workspace dep,
  `.ts`-suffixed subpath import) instead of forking the spawn/abort pump.

## Agentic auto-story pass (2026-09-05)

Story mode gained an **Auto ✨ author**: one idea line in, one voiced film
out — still one job, one UI. Pipeline stages (JobStage union extended):

1. **writing** — local brain: LM Studio at `localhost:1234`
   (prism-ml/bonsai-27b 2-bit, vision+reasoning-capable) via a thin
   self-contained client (`lib/brain.ts`, modeled on movie-director's
   lmstudio.ts contract but NOT importing it — that pulls
   s2-agent-core-runtime's full index into the GUI server). Writes titled
   scenes {visual, narration} as strict JSON. Prompt hard-rules: same
   language as the idea (title included), protagonist appearance repeated
   in every visual (the only continuity anchor across independently
   generated keyframes), ambient sound cues for LTX's audio branch,
   narration ≤ 2.5 words/sec of clip (measured Kokoro speech rate).
   `reasoning_effort:"none"` fast path first — bonsai's default reasoning
   mode wandered past 180 s timeouts; warm fast path measured 8.1 s.
   Missing narration retries once, then soft-lands visuals-only.
2. **keyframes / grid** — unchanged (flux2 6-step, seed family).
3. **voice** — Kokoro 82M TTS (reuses movie-director's
   `kokoro_tts_native.ts` — runtime-light: node builtins + type-only
   imports) against the prebuilt `swift/musicgen-director` binary; 24 kHz
   WAV per scene; voice picker (Auto = language-aware af_heart/zf_xiaobei).
   Voice failure is non-fatal — story delivers silent with a warning +
   story.json records why.
4. **rendering** — unchanged LTX native-storyboard (own soundtrack).
5. **mixing** — per-segment ffmpeg amix: narration (300 ms lead-in, padded,
   truncated at video end) over LTX's bed ducked to 0.32, video stream
   copied; segments concat via demuxer `-c copy` (no-narration segments
   re-encode audio to the same aac-192k so streams stay uniform).

story.json now carries title/idea/narrations/panels/voiced/brainModel; the
stage renders a script panel (scene cards: keyframe thumb + narration
quote + visual). Validation: idea 3–600 chars, voice a Kokoro id,
sceneCount 1–4.
