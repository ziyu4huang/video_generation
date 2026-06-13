# ltx-2.3-connector — LTX-2.3 Text Encoder Connector

HF repo: `dgrauet/ltx-2.3-mlx-q8`

## 包含文件

- `connector.safetensors` (~1.9 GB) — 連接 Gemma-3-12B 與 LTX transformer，MLX 4-bit 量化
- `config.json` — HF 模型配置
- `embedded_config.json` — 嵌入架構配置（audio VAE 用）

## Conversion

```bash
python/venv/bin/python python/mlx-movie-director/convert.py --ltx-connector
```

All 114 Linear layers quantized to 4-bit (group_size=32): 6,051 MB → 1,893 MB.

## 注意

Text encoder 本體（`mlx-community/gemma-3-12b-it-4bit`，~7 GB）由 pipeline 自動從 HF Hub 下載，儲存在 `~/.cache/huggingface/`。
