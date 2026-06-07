# ltx-2-mlx — vendored submodule

Source: https://github.com/dgrauet/ltx-2-mlx  
Model:  `dgrauet/ltx-2.3-mlx-q8` (int8, ~21 GB)  
Text encoder: `mlx-community/gemma-3-12b-it-4bit` (~7 GB, auto-downloaded by pipeline on first run)

---

## Setup

### Step 1 — 確認子模塊已克隆

```bash
git submodule update --init python/mlx-movie-director/vendor/ltx-2-mlx
# 確認包目錄存在：
ls vendor/ltx-2-mlx/packages/ltx-pipelines-mlx/src/ltx_pipelines_mlx/
```

### Step 2 — 安裝 Python 依賴

```bash
/Users/huangziyu/proj/video_generation/python/venv/bin/pip install \
    "mlx>=0.31.0" \
    "mlx-arsenal>=0.2.4" \
    "mlx-lm>=0.31.0" \
    "safetensors>=0.4.0" \
    "huggingface-hub>=0.26.0"
```

驗證：

```bash
/Users/huangziyu/proj/video_generation/python/venv/bin/python -c \
    "from ltx_pipelines_mlx import TI2VidTwoStagesPipeline; print('OK')"
# 若報 ModuleNotFoundError: ltx_pipelines_mlx → 重新確認步驟 1
# 若報 ModuleNotFoundError: mlx_arsenal       → 重新執行步驟 2
```

### Step 3 — 下載模型文件（~21 GB）

```bash
cd /Users/huangziyu/proj/video_generation/python/mlx-movie-director

/Users/huangziyu/proj/video_generation/python/venv/bin/python \
    app/ltx_downloader.py
```

各組件下載到 `models/{type}/{name}/`（詳見下方「模型文件分配」）。  
下載完成後更新各 `manifest.json` 的 `size_bytes` 為實際大小。

### Step 4 — 驗證

```bash
# argparse + frames 驗證（不需要模型）
/Users/huangziyu/proj/video_generation/python/venv/bin/python run.py video --help

# manifest 一致性檢查（模型下載後應 0 errors）
/Users/huangziyu/proj/video_generation/python/venv/bin/python run.py check-manifests

# 首次 T2V 生成（會自動下載 Gemma 3 12B text encoder ~7 GB 到 ~/.cache/）
/Users/huangziyu/proj/video_generation/python/venv/bin/python run.py video \
    --prompt "cinematic sunset over ocean, golden light" \
    --fps 24 --frames 49 --seed 42
```

---

## 模型文件分配

`dgrauet/ltx-2.3-mlx-q8` 的平坦 HF 倉庫文件，分散存入現有的 `models/{type}/{name}/` 結構：

| HF 文件 | 存放目錄 | 大小 |
|---------|---------|------|
| `transformer-dev.safetensors` | `models/transformer/ltx-2.3-dev-q8/` | ~19.2 GB |
| `split_model.json`, `quantize_config.json` | `models/transformer/ltx-2.3-dev-q8/` | — |
| `ltx-2.3-22b-distilled-lora-384.safetensors` | `models/lora/ltx-2.3-distilled/` | ~7.1 GB |
| `connector.safetensors` | `models/text_encoder/ltx-2.3-connector/` | ~5.9 GB |
| `config.json`, `embedded_config.json` | `models/text_encoder/ltx-2.3-connector/` | — |
| `vae_encoder.safetensors`, `vae_decoder.safetensors` | `models/vae/ltx-2.3-vae/` | ~1.4 GB |
| `spatial_upscaler_x2_v1_1.safetensors` | `models/vae/ltx-2.3-vae/` | optional |
| `audio_vae.safetensors`, `vocoder.safetensors` | `models/audio/ltx-2.3-audio/` | ~350 MB |

`app/ltx_pipeline.py` 在初始化時建立臨時平坦 symlink 目錄，讓 ltx-2-mlx 看到它期望的 `root/*.safetensors` 平坦結構。  
組裝目錄在 pipeline 銷毀時自動清除（`__del__`）。

---

## Import 方式（NOT pip-installed）

`app/ltx_pipeline.py` 在 import 時將以下路徑插入 `sys.path`：

```
vendor/ltx-2-mlx/packages/ltx-core-mlx/src/
vendor/ltx-2-mlx/packages/ltx-pipelines-mlx/src/
```

無需 `pip install ltx-2-mlx`，只需確認子模塊已克隆且依賴已安裝。

---

## 更新子模塊

```bash
git submodule update --remote python/mlx-movie-director/vendor/ltx-2-mlx
# 更新後確認 API 未變更：
/Users/huangziyu/proj/video_generation/python/venv/bin/python \
    python/mlx-movie-director/run.py video --help
```
