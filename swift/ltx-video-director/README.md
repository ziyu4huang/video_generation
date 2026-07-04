# ltx-video-director

Swift front-end for LTX-2.3 I2V generation on Apple Silicon, plus a native
video/image/voice quality gateway. Sibling to `z-image-director` and
`flux2-image-director`; shares `image-gen-utils` (VLM caption client, image
metrics) and `common-image-director` (ImageGate, ESRGAN, scheduler).

See [PLAN.md](PLAN.md) for the full porting log and
[docs/TODO.md](docs/TODO.md) for open milestones. Two parallel I2V paths
exist (see "native-i2v vs i2v" below): `i2v` still bridges the denoising loop
to `run.py` (Phase 0, production quality); `native-i2v` is the newer 100%
native Swift/MLX path (no run.py anywhere, distilled transformer only). The
quality gateway, VLM verify, and model discovery are native Swift in both.

## Build

```bash
cd swift/ltx-video-director
swift build -c release
./scripts/setup-metallib.sh release   # one-time: copy the venv's mlx.metallib next to the built binary
swift test
```

`swift run ltx-video <cmd>` (debug config) also works for iteration; use
`-c release` for real generation runs — debug MLX is dramatically slower.

## Usage — native (no run.py)

```bash
# List installed LTX-2.3 transformer variants
swift run ltx-video models

# THE FLAGSHIP command: I2V, 100% native Swift/MLX. Auto-upscales 2x + refines
# by default, and muxes the result into a real .mp4 (--no-upscale / --no-mp4 to skip).
swift run ltx-video native-i2v \
  --prompt "a beautiful young woman standing on a bustling city street at golden hour" \
  --seconds 2 --width 640 --height 960 --output out/

# native-i2v with First-Last-Frame conditioning, custom audio, and LoRA fusion
swift run ltx-video native-i2v --prompt "..." \
  --last-frame end.png --audio-track voice.wav \
  --lora style.safetensors:0.8 --output out/

# Standalone 2x native spatial upscale of an existing frame sequence (fast mode
# only — hd mode is not yet natively ported, see "native-upscale hd mode" below)
swift run ltx-video native-upscale --input out/frames --output out/upscaled

# Low-level diagnostics: decode a latent straight to PNG/WAV (or --zeros for a smoke test)
swift run ltx-video video-decode --zeros --output out/decode_frames
swift run ltx-video audio-decode --zeros --output out/decode_audio.wav
```

## Usage — production pipeline (bridges run.py) + quality tools

```bash
# 10s I2V: beautiful girl on a street, distilled model, with speech
swift run ltx-video i2v \
  --prompt "a beautiful young woman standing on a bustling city street at golden hour" \
  --action "她微笑著轉向鏡頭，輕聲說「嗨，你好」" \
  --seconds 10 --transformer dasiwa

# Basic (VLM-free) video/image/voice quality gateway
swift run ltx-video gate output.mp4 --json

# VLM keyframe verification (needs LM Studio running locally)
swift run ltx-video verify output.mp4 --prompt "a beautiful young woman on a street"

# LTX's IC-LoRA restore+upscale stack (bridges run.py — the higher-quality,
# not-yet-natively-ported upscale path; see "native-upscale hd mode" below)
swift run ltx-video upscale output.mp4 --scale 2.0 --self-verify
```

## `native-i2v` vs `i2v`

- **`native-i2v`** — 100% native Swift/MLX, zero run.py anywhere. Distilled
  transformer only, no VLM prompt expansion. Writes a PNG frame sequence +
  `audio.wav`, and (on by default, `--no-mp4` to skip) muxes them into a real
  `video.mp4` via `MP4Writer.swift` (AVAssetWriter — H.264+AAC). Supports FFLF
  (`--last-frame`), custom audio injection (`--audio-track`), LoRA fusion
  (`--lora`), and an automatic post-upscale + refine pass (on by default).
- **`i2v`** — the production pipeline (ZImage T2I → VLM prompt → LTX I2V).
  Still bridges through `run.py` internally for the VLM/quality-check/
  vlm-score stages. Higher default quality/duration, writes a real `.mp4`.

## `native-upscale` hd mode (not yet natively ported)

`native-upscale --mode fast` is a real native port of LTX-2.3's
`LatentUpsampler` (small Conv3d/Conv2d ResNet, no LoRA, no transformer) — used
standalone or automatically by `native-i2v`.

`--mode hd` refers to a *different*, much larger mechanism: the official
`Lightricks/LTX-2.3-22b-IC-LoRA-Pixel-Spatial-Upscaler` — a LoRA fused onto
the full 22B transformer, generative (synthesizes detail, also removes
watermarks/subtitles), two-stage (half-res-with-LoRA → full-res-without-LoRA),
with whole-clip reference-frame conditioning (architecturally different from
this package's single-frame I2V conditioning). Porting it natively is a
comparably-sized undertaking to `NativeI2VStage` itself — LoRA weight
loading/fusion (nothing in this package parses a LoRA safetensors file today),
a new reference-conditioning token-construction module, and a second
denoise-loop invocation. See PLAN.md's "Research: native spatial upscaling"
section for the full dependency-ordered plan. Until it lands, `--mode hd`
just prints the equivalent run.py-bridged `ltx-video upscale` invocation
instead of running, and that bridged command remains the only way to get this
exact upscaler today.

## Requirements

- The mlx venv + already-converted LTX-2.3 checkpoints from
  `python/mlx-movie-director` (`i2v`/`upscale`/`--bridge`-equivalent paths —
  see PLAN.md; `native-i2v`/`native-upscale --mode fast` need no venv/Python
  at runtime).
- LM Studio running locally (Qwen3-VL) for `verify`.
