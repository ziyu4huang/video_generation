# ltx-2.3-dev-q8 — LTX-2.3 22B Stage-1 Dev Transformer (int8)

HF repo: `dgrauet/ltx-2.3-mlx-q8`

## 包含文件

- `transformer-dev.safetensors` (~19.18 GB) — Stage-1 dev transformer 權重
- `split_model.json` — 分片模型配置（若存在）
- `quantize_config.json` — 量化配置（若存在）

## 下載

```bash
python python/mlx-movie-director/app/ltx_downloader.py --component transformer
```

或讓 `run.py video` 首次執行時自動下載。
