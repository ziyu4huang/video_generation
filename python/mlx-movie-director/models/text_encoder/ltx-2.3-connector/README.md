# ltx-2.3-connector — LTX-2.3 Text Encoder Connector

HF repo: `dgrauet/ltx-2.3-mlx-q8`

## 包含文件

- `connector.safetensors` (~5.91 GB) — 連接 Gemma-3-12B 與 LTX transformer
- `config.json` — HF 模型配置
- `embedded_config.json` — 嵌入架構配置（audio VAE 用）

## 注意

本地端只儲存 `connector.safetensors`。
Text encoder 本體（`mlx-community/gemma-3-12b-it-4bit`，~7 GB）由 pipeline 自動從 HF Hub 下載，儲存在 `~/.cache/huggingface/`。
