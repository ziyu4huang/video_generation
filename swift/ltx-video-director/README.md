# ltx-video-director

Swift front-end for LTX-2.3 I2V generation on Apple Silicon, plus a native
video/image/voice quality gateway. Sibling to `z-image-director` and
`flux2-image-director`; shares `image-gen-utils` (VLM caption client, image
metrics) and `common-image-director` (ImageGate, ESRGAN, scheduler).

See [PLAN.md](PLAN.md) for the porting strategy — the LTX-2.3 denoising loop
is currently bridged to `run.py` (Phase 0); the quality gateway, VLM verify,
and model discovery are native Swift today.

## Build

```bash
cd swift/ltx-video-director
swift build
./scripts/setup-metallib.sh   # one-time: copy the venv's mlx.metallib next to the built binary
swift test
```

## Usage

```bash
# List installed LTX-2.3 variants (mlx-models/ltx-mlx/{dev,distilled,dasiwa})
swift run ltx-video models

# 10s I2V: beautiful girl on a street, distilled model, with speech
swift run ltx-video i2v \
  --prompt "a beautiful young woman standing on a bustling city street at golden hour" \
  --action "她微笑著轉向鏡頭，輕聲說「嗨，你好」" \
  --seconds 10 --transformer dasiwa

# Basic (VLM-free) video/image/voice quality gateway
swift run ltx-video gate output.mp4 --json

# VLM keyframe verification (needs LM Studio running locally)
swift run ltx-video verify output.mp4 --prompt "a beautiful young woman on a street"

# LTX's native spatial upscaler (2x)
swift run ltx-video upscale output.mp4 --scale 2.0 --self-verify
```

## Requirements

- The mlx venv + already-converted LTX-2.3 checkpoints from
  `python/mlx-movie-director` (Phase 0 bridges generation there — see PLAN.md).
- LM Studio running locally (Qwen3-VL) for `verify`.
