# ltx-2.3-dasiwa-golden-lace-v3-q8

DaSiWa LTX-2.3 'Golden Lace v3' transformer, MLX int8.

- **Source**: Civitai [2543443/2967331](https://civitai.com/models/2543443) (baseModel LTXV 2.3, FP8/BF16 safetensors)
- **Converted**: `convert.py --ltx-checkpoint DasiwaLTX23_goldenLaceV3.safetensors`
- **Weight file**: `transformer-dev.safetensors` (named for the dev-architecture slot; this dir IS the DaSiWa finetune)
- **Size**: 20.6 GB
- **Quantization**: int8, group_size=64, transformer_blocks linears only

Use via `run.py video generate --transformer dasiwa`.
