# krea2-image-director — Swift Port Plan

Pure-Swift Krea 2 Turbo T2I/I2I on Apple Silicon. Mirrors the
`swift/ltx-video-director` methodology: **Phase 0 bridge → native port,
parity-tested component-by-component against the python reference.**

The python reference (`python/mlx-movie-director/app/krea2_*.py` +
`scripts/krea2_smoke.py`) is **done and parity-validated end-to-end** — it
produces photorealistic 1024² images (VLM 8.5/10) and every component matches
the torch `krea-ai/krea-2` oracle. This package is the Swift re-implementation.

## Status

- **Phase 0 (bridge, this commit):** `krea2 t2i` shells out to
  `scripts/krea2_smoke.py` (the verified python pipeline) → working CLI today.
- **Phase 1+ (native port):** pending — port the DiT/VAE/Qwen3 encoder to
  Swift MLX, parity-tested per component.

## Python reference (already shipped)

| Component | File | Parity vs torch |
|---|---|---|
| SingleStreamDiT (28 blocks, GQA, gated sigmoid, manual attn) | `app/krea2_transformer.py` | RoPE 1e-7, modulation 0.03%, qknorm 0.002%, rope-apply 0.0000%, txtfusion 0.15% |
| Qwen3-VL-Instruct 12-layer encoder | `app/krea2_encoder.py` | shape-exact (B,512,12,2560) |
| qwen_image_vae decoder (2D-collapse of 3D causal convs) | `app/krea2_vae.py` | max-diff 0.0166 |
| T2I pipeline + sampler | `scripts/krea2_smoke.py` | 1024² in ~44s, VLM 8.5/10 |

## Native port plan (per ltx-video-director)

1. `scripts/dump_*_reference.py` — capture python intermediate tensors to
   `test_refs/` (rope freqs, temb, txtfusion, single block, full DiT, vae
   decode, end-to-end sampler golden image). **Highest-risk first: txtfusion.**
2. Port each as a Swift `struct` taking dequantized `MLXArray` weights; write
   `*ParityTests.swift` asserting max-abs-diff < tolerance.
3. `Krea2CheckpointLoader` — dequantize-on-load + block-streaming (12B is the
   biggest model in the repo; memory tight at high res).
4. Reuse `z-image-director`'s native Qwen3 + WeightStore (extend Qwen3 to the
   12-layer tap + chat template + 34-token strip).
5. Retire the bridge.

## Build & run

```bash
cd swift/krea2-image-director
swift build
./scripts/setup-metallib.sh        # one-time: copy venv's mlx.metallib
swift test
swift run krea2 t2i --prompt "a fox in snow" --seed 42
```

## Risks (carried from the python port)

- **TextFusionTransformer** is Krea-specific (no analogue in flux2/z-image/lens)
  — highest port risk; parity-test in isolation first.
- **Manual attention**: the python port uses manual GQA attention (matmul +
  softmax + explicit mask) because `mx.fast.scaled_dot_product_attention`
  diverged in the full DiT graph. The Swift port should use `MLXFast.scaledDotProductAttention`
  but fall back to manual if parity fails.
- **12B memory** at 1536² (14k tokens padded to 256) — block-streaming + Q8
  essential; tight on 48 GB Macs.
