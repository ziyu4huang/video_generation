# Dark Beast KLEIN 9B V2.0 BFS

Fine-tuned Flux2 Klein 9B checkpoint, face-swap specialized variant.

## Source

- Model: [Dark Beast](https://civitai.com/models/2242173/dark-beast-or?modelVersionId=2740209)
- Version: DBKleinV2BFS (modelVersionId=2740209)
- Architecture: Flux2 Klein 9B (partial fine-tune, merged with base)

## WARNING: Model is currently broken (needs re-download)

The original Klein 9B checkpoint (DBKleinV2BFS, modelVersionId=2740209) is no longer in
Downloads. During the 2026-06-21 debugging session, the model directory was accidentally
overwritten by running `convert.py` against the wrong file:

- `darkBeast_dbzit9DIMRclaw_fp8.safetensors` is a **ZIT (ZImage Turbo)** model, not Klein 9B.
  Its keys use `layers.N.*` format with scalar `weight_scale` tensors only — incompatible
  with the Klein 9B `double_blocks.*` / `single_blocks.*` key structure.

The current shards contain only base klein-9b weights (no dark-beast fine-tuning).

## To restore

1. Re-download DBKleinV2BFS from civitai.com/models/2242173 (modelVersionId=2740209)
2. Re-convert:
   ```bash
   python/venv/bin/python python/mlx-movie-director/convert.py \
     --klein-9b-checkpoint /path/to/darkBeastKlein9B_v20bfs.safetensors \
     --name klein-9b-dark-beast-bfs
   ```
   The `norm_out.linear.weight` bug fix is already in `convert.py` — no extra steps needed.

## Conversion notes (for when restored)

The `final_layer.adaLN_modulation.1.weight` from ComfyUI Klein 9B checkpoints is intentionally
**not used** during conversion — it is statistically uncorrelated (r ≈ −0.002) with the
HuggingFace `norm_out.linear.weight` and causes a severe burlap texture. The base `norm_out`
is preserved. See `project_klein9b_normlayer_fix.md` in memory for details.
