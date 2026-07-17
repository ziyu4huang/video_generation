# ZImageDirector — Pure-Swift MLX Z-Image T2I

A self-contained Swift package porting the **Z-Image** text-to-image pipeline from
`python/mlx-movie-director/run.py` to **pure Swift** on Apple Silicon, using
`mlx-swift`.

> Status: **Fully E2E text-to-image** (Phase 0–5 complete). No Python runtime
> dependency. See `docs/PLAN.md` for the roadmap.

## Goals

- Pure-Swift, Metal-accelerated image generation (no Python runtime at execution time).
- Reuse the MLX weights already converted under
  `mlx-models/transformer/*` (8-bit MLX `safetensors`).
- CLI surface mirroring `run.py image t2i` (`zimage t2i --prompt ... --seed ...`).

## Architecture (ported from)

| Component        | Python source                                    | Swift target |
|------------------|--------------------------------------------------|--------------|
| Transformer (S3-DiT, 6B) | `app/transformer.py` `ZImageTransformerMLX` | `Sources/ZImageDirector/Transformer/` |
| T2I pipeline / denoise | `app/pipeline.py` `ZImagePipeline`          | `Sources/ZImageDirector/Pipeline/` |
| VAE (16-ch Flux latent) | `mflux.models.z_image.model.z_image_vae`    | `Sources/ZImageDirector/VAE/` |
| Text encoder     | `app/text_encoder.py` (Qwen-based)              | `Sources/ZImageDirector/TextEncoder/` |
| Weights / config | `mlx-models/transformer/*/config.json` | `Sources/ZImageDirector/Config.swift` |

## Requirements

- Swift 6.0+
- macOS 15+ (Apple Silicon)
- The repo's converted Z-Image weights (e.g. `moody-pro-mix`).

## Build

```bash
cd swift/z-image-director
swift build
```

## Run

End-to-end generation (one Python preprocessing step for the prompt embedding,
then pure-Swift generation):

```bash
# 1. (once per prompt) dump prompt embedding + optional uncond for CFG
python/venv/bin/python swift/z-image-director/scripts/dump_prompt_embedding.py \
    --prompt "a cinematic portrait of a woman, dramatic lighting" \
    --uncond --output swift/z-image-director/.scratch/emb/portrait.safetensors

# 2. pure-Swift generate (CFG auto-enabled when uncond_feats present)
swift run zimage t2i \
    --embedding swift/z-image-director/.scratch/emb/portrait.safetensors \
    --width 640 --height 960 --steps 4 --seed 99 \
    --output out.png
```

With identical input noise, the Swift output matches Python to **100% pixel-identity
within ±5/255** (cfg=4.0, correlation 0.9998). Speed: **1.23 s/it** (cfg-off),
**3.41 s/it** (cfg-on) — parity with Python's 1.24 s/it.

## Verification

Four numerical checkpoints against Python reference dumps:

```bash
zimage verify            # transformer forward (19 checks)
zimage verify-vae        # VAE decode (13 checks)
zimage verify-t2i        # denoise loop, cfg-off
zimage verify-t2i --cfg-scale 4.0 --embedding <cfg-emb.safetensors>  # cfg-on
```

## References

- `mlx-swift` — <https://github.com/ml-explore/mlx-swift>
- `mlx-swift-examples` — <https://github.com/ml-explore/mlx-swift-examples>
- `mzbac/flux.swift` — reference FLUX.1 port in Swift (shares Flux latent + VAE).
- `FiditeNemini/z-image-turbo-mlx` — reference MLX Z-Image implementation.
