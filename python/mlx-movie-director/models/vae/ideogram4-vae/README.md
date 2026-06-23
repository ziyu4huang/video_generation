# ideogram4-vae

Ideogram 4 component (poster/slide-optimized t2i). Source: [ideogram-ai/ideogram-4-nf4](https://huggingface.co/ideogram-ai/ideogram-4-nf4).

NF4 (bitsandbytes) weights are loaded as-is and dequantized at load by `app/ideogram4_nf4` (fork-free, stock mlx — no `lyonsno/mlx@nf4` dependency). Runtime architecture lives in `app/ideogram4_{transformer,vae,pipeline}.py`. See `manifest.json` for metadata and the project root `CLAUDE.md` / `docs/` for the full pipeline description.
