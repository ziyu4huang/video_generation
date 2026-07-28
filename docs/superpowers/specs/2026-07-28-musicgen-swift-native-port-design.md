# MusicGen Swift-native port (`music_generation` off Python)

## Context

Standing architecture rule (reaffirmed 2026-07-27, see
`project_ltx_swift_native_port` memory): Python is dev/spike-only; every
production CLI surface the TS agent bridge calls into must be Swift-native.
`music_generation` was flagged as the one known current violation —
`bun-apps/pi-agent-ext-movie-director/src/registry.ts:352`'s `musicgen_music`
provider entry is mislabeled `backend: "native_swift"` while its `invoke:
"mlx:runpy-music"` actually shells out to `run.py music`, which wraps the
third-party Python package `mlx_audiocraft.MusicGen` (Meta's MusicGen on
Apple Silicon via MLX, Python API only). TTS already went through this exact
migration on 2026-07-13 (`mlx:runpy-tts` → `bun:tts-native`, backed by the
`msedge-tts` npm package) — `music_generation` is the last Python-bridged
generation provider in this pi-extension.

Phase 0 research (2026-07-28, see `project_musicgen_swift_native_research`
memory) mapped `facebook/musicgen-small`'s exact architecture from its real
`config.json` and confirmed two of its three components have real Swift/MLX
starting points to adapt rather than invent from scratch:

- **Text encoder**: `t5-base` (d_model=768, 12 layers, 12 heads, d_kv=64,
  plain relu-dense FFN, vocab 32128). This repo already has a T5 encoder in
  Swift — `swift/flux2-image-director/Sources/Flux2Director/
  KontextT5Encoder.swift` — built for FLUX's T5-XXL. Confirmed by reading its
  source: the relative-position-bias attention, RMSNorm-style layer norm, and
  overall block/weight-loading structure are directly reusable, but its FFN
  (`KT5DenseReluDense`) is actually the GATED variant (`wi_0`/`wi_1` two-matrix
  gate) used by T5-v1.1/XXL — MusicGen's plain `t5-base` uses the ORIGINAL
  T5's single-matrix `wi` + plain relu (different weight keys, different
  forward pass). `numHeads`/`headDim` are also hardcoded `static let` values
  (64/64 for XXL) that need to become instance config (12/64 for t5-base).
- **Audio codec**: `facebook/encodec_32khz` (hidden=128, 4 codebooks @ 50Hz,
  target bandwidth 2.2kbps, only the DECODER half needed since this is pure
  T2A). No Swift implementation exists in this repo, but
  [`Blaizzy/mlx-audio-swift`](https://github.com/Blaizzy/mlx-audio-swift)
  (MIT, active) has one — confirmed by reading its actual
  `EncodecConfig.swift`: a fully data-driven `Codable` struct whose field
  names match HF's `audio_encoder` config block almost 1:1
  (`num_filters`/`num_lstm_layers`/`upsampling_ratios`/`codebook_size`/
  `codebook_dim`/`hidden_size`/`norm_type`/`sampling_rate`). Its *default*
  preset is 24kHz-speech-shaped, but that's just a default — the struct
  itself accepts our exact 32kHz config values. The one thing NOT verified
  this session: whether `Encodec.swift`/`EncodecLayers.swift` (the actual
  layer math) hardcodes anything tied to the 24kHz defaults.
- **MusicGen's own LM decoder transformer**: NOT found anywhere on GitHub in
  Swift or MLX-Swift form. The only comparable prior art
  (`andrade0/musicgen-mlx`) is Python MLX, low-maturity, and even keeps its
  own T5 encoder in PyTorch — architecturally equivalent to (not better than)
  the `mlx_audiocraft` package the current Python bridge already uses. This
  is confirmed as a genuine from-scratch port: 24 pre-norm transformer layers
  (hidden=1024, 16 heads, ffn_dim=4096), causal self-attention + cross-
  attention to T5 hidden states, one separate embedding table per codebook
  (4 tables, summed), sinusoidal positional embeddings, plus MusicGen's
  "delay pattern" codebook-interleaving scheme (codebook `i` shifted right by
  `i` positions; fully specified in the Phase 0 memory from HF's
  `modeling_musicgen.py` source).

A detail not previously flagged but standard to MusicGen's generation loop
and required for faithful behavior: **classifier-free guidance**. Each
autoregressive step runs the LM decoder twice — once with the real text
conditioning, once with an empty/null conditioning — and blends the two
logit distributions by a guidance coefficient (`cfg_coef`, audiocraft's
default is 3.0) before sampling. This doubles per-step compute but is not
optional; skipping it changes the model's actual generation behavior versus
the Python reference, which would break the verification plan below.

## Scope (v1)

Only `musicgen-small` (300M) ships in v1 — matching the Python bridge's
current default and the size the Phase 0 research mapped exactly.
`musicgen-medium`/`-large`/stereo/melody variants are explicitly OUT of v1:
same overall architecture at different layer/width counts, but not
measured or verified this session, and melody conditioning is a materially
different input path (audio-conditioned, not just text) not covered here.
`run.py music` itself is NOT deleted — it stays as the dev-time reference
implementation this port's verification plan compares against (consistent
with the standing rule: Python is kept for development/comparison, not
production).

## 1. New package: `swift/musicgen-director`

Follows this repo's existing one-package-per-model-family convention
(`z-image-director`, `krea2-image-director`, `flux2-image-director`,
`ltx-video-director`). Structure:

```
swift/musicgen-director/
  Package.swift              # depends on mlx-swift (MLX/MLXNN/MLXFast, same
                              # as every other director package) and
                              # Blaizzy/mlx-audio-swift (MLXAudioCodecs
                              # product only, not the TTS/STT/VAD products)
  Sources/MusicGenDirector/
    MusicGenT5Encoder.swift   # ported from KontextT5Encoder.swift: relative-
                              # position-bias attention + RMSNorm reused,
                              # NEW plain single-matrix relu FFN struct added,
                              # numHeads/headDim/dModel/numLayers become
                              # constructor params instead of hardcoded statics
    MusicGenDecoder.swift     # new: 24-layer pre-norm transformer, causal
                              # self-attn + cross-attn to T5 hidden states,
                              # 4 per-codebook embedding tables (summed),
                              # sinusoidal positional embeddings
    DelayPattern.swift        # new: build/apply delay-pattern mask (per
                              # Phase 0 memory's exact algorithm), codebook
                              # interleave/de-interleave
    MusicGenGenerator.swift   # new: the autoregressive sampling loop —
                              # classifier-free guidance (real + null
                              # conditioning batches), top-k/temperature
                              # sampling matching audiocraft's defaults,
                              # duration → step-count conversion (50Hz frame
                              # rate + delay-pattern's fixed extra steps)
    MusicGenEncodecAdapter.swift  # thin wrapper configuring mlx-audio-swift's
                              # EncodecConfig/Encodec with facebook/
                              # encodec_32khz's real numbers, decode-only
    MusicGenWeights.swift     # safetensors loader for the 3 checkpoint
                              # sub-trees (text_encoder/decoder/audio_encoder)
  Sources/MusicGenDirectorCLI/
    MusicGenCLI.swift         # `musicgen generate --prompt --duration --output --seed`
    VerifyT5Command.swift     # `musicgen verify-t5` — numerical parity vs HF t5-base
    VerifyEncodecCommand.swift    # `musicgen verify-encodec` — decode parity
    VerifyDecoderStepCommand.swift # `musicgen verify-decoder-step` — single-step logits parity
  Tests/MusicGenDirectorTests/
```

## 2. Checkpoint import

HF `facebook/musicgen-small` splits into three sub-models
(`text_encoder/`, `decoder/`, `audio_encoder/`), each with its own
safetensors. `import-lora-image.py`'s convention (single-file LoRA →
external-store symlink) doesn't fit a 3-part checkpoint. New one-time
Python import script (dev-tooling only, same standing-rule carve-out as
`import-lora-image.py` itself — a setup tool is not a production generation
code path): downloads the HF snapshot, re-groups the three sub-trees into
this repo's `mlx-models/` external-store convention, e.g.:

```
mlx-models/musicgen/musicgen-small/
  text_encoder.safetensors   -> symlink into video_generation__models/<md5>
  decoder.safetensors        -> symlink into video_generation__models/<md5>
  audio_encoder.safetensors  -> symlink into video_generation__models/<md5>
  manifest.json
```

Also registers into the repo-root `mlx-models/store-manifest.json`, per the
convention the camera-control-LoRA import task already established.

## 3. TS integration (replaces the Python bridge)

Mirrors TTS's 2026-07-13 migration precedent exactly:

- New `bun-apps/pi-agent-ext-movie-director/src/music_native.ts` — calls the
  built `musicgen` Swift binary via `ensureBinary()` (same pattern as the
  LTX/lipsync-metrics native commands), same input shape as
  `runpy_music.ts`'s `RunPyMusicOptions` (`prompt`, `duration`, `model`,
  `output`) so `bridge.ts`'s existing `adaptRunPyMusic` ToolResult adapter
  can be reused as-is (structurally compatible `Details` shape, same
  "0-exit but nothing written is NOT success" stance).
- `bridge.ts` gains `realMusicNative`, following `realTtsNative`'s shape.
- `registry.ts:352`'s `musicgen_music` entry's `invoke` changes from
  `mlx:runpy-music` to the new native invoke key — this also FIXES the
  existing `backend: "native_swift"` mislabel (it becomes true instead of
  aspirational).
- `run.py music` / `runpy_music.ts` / the old `mlx:runpy-music` invoke path
  stay in the codebase (dev/reference use, not deleted) — same disposition
  as `run.py`'s other superseded-but-kept dev paths.

## 4. Verification plan

Layered numerical parity (each needs a matching Python reference script),
same methodology as the Kontext CLIP+T5 epic:

1. **T5 encoder**: `musicgen verify-t5` feeds identical tokenized input
   through the Swift port and real HF `T5EncoderModel` (`t5-base`), compares
   hidden-state cosine similarity — target ≥0.99.
2. **EnCodec decode**: fixed/known codebook indices decoded through both
   Swift (`mlx-audio-swift`'s Encodec, configured with our real 32khz
   numbers) and Python (`transformers.EncodecModel` or `mlx_audiocraft`'s
   own encodec) — compare output waveform cosine/correlation.
3. **LM decoder single step**: identical text conditioning + partial
   codebook history through one deterministic greedy forward pass (no
   sampling) on both sides — compare logits distribution cosine similarity.
   Deliberately NOT a full multi-step generation comparison, since sampling
   randomness would make that comparison meaningless.
4. **End-to-end real generation**: same prompt (reusing an existing
   self-test prompt from `run.py music`) run through both the full Swift
   pipeline and `run.py music`, producing two real wav files. Compared via
   spectral/energy-distribution similarity (RMS, frequency-band energy,
   frame-to-frame variance) — the same "spectral read, not a human-listening
   pass" methodology already used for the `ambient_sound` capability-matrix
   row. No hard pass/fail threshold here (generation has real sampling
   randomness, so bit-exact or even high-cosine match isn't the right bar) —
   the acceptance criterion is that Swift's output is a real, non-silent,
   spectrally-plausible piece of audio, not silence or noise.

Acceptance gate: layers 1-3 must each clear cosine ≥0.99, or the
architecture port has a real bug that needs fixing before moving on. Layer 4
is a sanity/regression check, not a numeric gate.

## Out of scope

- `musicgen-medium`/`-large`/stereo/melody variants (v1 is small-only).
- Deleting `run.py music` / the Python bridge code (kept as dev reference).
- Any change to `compose-motion`'s `amix` audio-mixing consumer of the
  produced score track — this port only changes how the file is produced,
  not its downstream consumption.
- Vendoring/forking `mlx-audio-swift`'s EnCodec code into this repo (v1 uses
  it as a live SPM dependency, not a vendored copy).
