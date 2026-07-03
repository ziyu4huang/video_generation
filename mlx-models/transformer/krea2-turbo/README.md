# krea2-turbo

Krea 2 Turbo (OSS_TURBO) single-stream MMDiT — **8-bit MLX (group_size=64)**.

- **Arch**: 28 blocks × 6144 dim, GQA (48 query / 12 KV heads), patch 2×2, 16-ch latent.
- **Text encoder**: Qwen3-VL-4B-Instruct LM half, 12-layer hidden-state tap.
- **VAE**: qwen-image-vae (f8, 16ch).
- **Sampler**: flow-matching Euler, CFG-free, 8 steps, mu=1.15.

Produced from the bf16 `turbo.safetensors` (24 GB) by
`python/mlx-movie-director/scripts/krea2_quantize_turbo.py` → 13.65 GB (52%).

Consumed by the **pure-Swift** port `swift/krea2-image-director` (zero Python).
`Krea2DiT.lin()` auto-detects quantized weights via the `weight.scales` companion
key and dispatches to `MLX.quantizedMM`; otherwise plain matmul.

Quality (native Swift t2i 1024²): VLM 8/10 vs 9.2 bf16 (within variance).
