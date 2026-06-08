# ltx-2-mlx — vendored submodule (active pipeline)

Source: https://github.com/dgrauet/ltx-2-mlx
Model:  `dgrauet/ltx-2.3-mlx-q8` (int8, ~50 GB total)
Text encoder: `mlx-community/gemma-3-12b-it-4bit` (~7 GB, auto-downloaded by pipeline on first run)

> **Related vendor submodules:**
> - [`vendor/ltx-2-mlx-dgrauet/`](ltx-2-mlx-dgrauet/) — Read-only reference copy of the same upstream repo
> - [`vendor/ltx-2-mlx-acelogic/`](ltx-2-mlx-acelogic/) — Acelogic fork (reference only; see [`AUDIO_ISSUES.md`](ltx-2-mlx-acelogic/AUDIO_ISSUES.md) for audio debugging log)
> - [`vendor/ltx-2-mlx-acelogic.README.md`](ltx-2-mlx-acelogic.README.md) — Why Acelogic text encoder fixes are NOT needed for our pipeline
> - [`vendor/mflux.README.md`](mflux.README.md) — mflux submodule (Flux2 Klein / Z-Image)

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

### Step 3 — 下載模型文件（~50 GB）

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

`dgrauet/ltx-2.3-mlx-q8` 的平坦 HF 倉庫文件，分散存入 `models/{type}/{name}/` 結構。
**Dev 和 Distilled pipeline 共用所有周邊組件**（text encoder、VAE、upscaler、audio），僅 transformer 和 LoRA 不同。

```
models/
├── transformer/
│   ├── ltx-2.3-dev-q8/                     ← DEV pipeline
│   │   ├── transformer-dev.safetensors              (19.2 GB, v1.0)
│   │   ├── config.json
│   │   ├── split_model.json
│   │   └── quantize_config.json
│   │
│   └── ltx-2.3-distilled-q8/               ← DISTILLED pipeline
│       ├── transformer-distilled-1.1.safetensors    (19.2 GB, v1.1)
│       ├── config.json                              (same architecture)
│       ├── split_model.json
│       └── quantize_config.json
│
├── lora/
│   └── ltx-2.3-distilled/                  ← DEV pipeline Stage 2 only
│       ├── ltx-2.3-22b-distilled-lora-384.safetensors        (7.1 GB, v1.0)
│       └── ltx-2.3-22b-distilled-lora-384-1.1.safetensors    (7.1 GB, v1.1)
│
├── text_encoder/                            ← SHARED
│   └── ltx-2.3-connector/
│       ├── connector.safetensors                    (5.9 GB)
│       ├── config.json
│       └── embedded_config.json
│
├── vae/                                     ← SHARED
│   └── ltx-2.3-vae/
│       ├── vae_encoder.safetensors                  (608 MB)
│       ├── vae_decoder.safetensors                  (777 MB)
│       ├── spatial_upscaler_x2_v1_1.safetensors     (950 MB)  ← Stage 2 spatial 2×
│       ├── spatial_upscaler_x2_v1_1_config.json
│       ├── spatial_upscaler_x1_5_v1_0.safetensors   (1.0 GB)  (not yet wired)
│       ├── spatial_upscaler_x1_5_v1_0_config.json
│       ├── temporal_upscaler_x2_v1_0.safetensors    (250 MB)  ← temporal frame interp
│       └── temporal_upscaler_x2_v1_0_config.json
│
└── audio/                                   ← SHARED (A2V only)
    └── ltx-2.3-audio/
        ├── audio_vae.safetensors                    (102 MB)
        └── vocoder.safetensors                      (246 MB)
```

### HF 文件 → 本地目錄映射

| HF 文件 | 存放目錄 | 大小 | 備註 |
|---------|---------|------|------|
| `transformer-dev.safetensors` | `models/transformer/ltx-2.3-dev-q8/` | 19.2 GB | Dev transformer v1.0 |
| `transformer-distilled-1.1.safetensors` | `models/transformer/ltx-2.3-distilled-q8/` | 19.2 GB | Distilled transformer v1.1 |
| `ltx-2.3-22b-distilled-lora-384.safetensors` | `models/lora/ltx-2.3-distilled/` | 7.1 GB | Stage 2 LoRA v1.0 |
| `ltx-2.3-22b-distilled-lora-384-1.1.safetensors` | `models/lora/ltx-2.3-distilled/` | 7.1 GB | Stage 2 LoRA v1.1 |
| `connector.safetensors` | `models/text_encoder/ltx-2.3-connector/` | 5.9 GB | Gemma → LTX connector |
| `config.json`, `embedded_config.json` | `models/text_encoder/ltx-2.3-connector/` | — | |
| `vae_encoder.safetensors`, `vae_decoder.safetensors` | `models/vae/ltx-2.3-vae/` | 1.4 GB | |
| `spatial_upscaler_x2_v1_1.safetensors` | `models/vae/ltx-2.3-vae/` | 950 MB | Stage 2 spatial 2× |
| `spatial_upscaler_x1_5_v1_0.safetensors` | `models/vae/ltx-2.3-vae/` | 1.0 GB | Optional (not yet wired) |
| `temporal_upscaler_x2_v1_0.safetensors` | `models/vae/ltx-2.3-vae/` | 250 MB | Temporal frame interp |
| `audio_vae.safetensors`, `vocoder.safetensors` | `models/audio/ltx-2.3-audio/` | 350 MB | A2V mode |
| `split_model.json`, `quantize_config.json` | `models/transformer/ltx-2.3-*/` | — | Copied to both transformer dirs |

`app/ltx_pipeline.py` 在初始化時建立平坦 symlink 目錄，讓 ltx-2-mlx 看到它期望的 `root/*.safetensors` 平坦結構。

### Pre-built Flat Dirs (`models/ltx-mlx/`)

Instead of creating temp dirs on-the-fly, pre-built symlink dirs can be created once:

```bash
python scripts/setup_ltx_symlinks.py          # create dev/ and distilled/
python scripts/setup_ltx_symlinks.py --check   # verify
python scripts/setup_ltx_symlinks.py --force   # recreate from scratch
```

```
models/ltx-mlx/
├── .gitignore          # ignores dev/ and distilled/ (machine-specific symlinks)
├── dev/                ← for T2V/I2V/A2V/HQ/FLF2V
│   ├── transformer-dev.safetensors → ../../transformer/ltx-2.3-dev-q8/transformer-dev.safetensors
│   ├── ltx-2.3-22b-distilled-lora-384.safetensors → ../../lora/ltx-2.3-distilled/...
│   ├── connector.safetensors → ../../text_encoder/ltx-2.3-connector/connector.safetensors
│   ├── vae_encoder.safetensors → ../../vae/ltx-2.3-vae/vae_encoder.safetensors
│   └── ...
└── distilled/          ← for --distilled fast generation
    ├── transformer-distilled-1.1.safetensors → ../../transformer/ltx-2.3-distilled-q8/...
    ├── connector.safetensors → ../../text_encoder/ltx-2.3-connector/connector.safetensors
    └── ...
```

The pipeline (`app/ltx_pipeline.py`) checks for pre-built dirs first; falls back to temp assembly if not found. Pre-built dirs are never auto-deleted.

---

## Dev vs Distilled 模型對照

| | Dev (v1.0) | Distilled (v1.1) |
|---|---|---|
| **Transformer** | `ltx-2.3-dev-q8` | `ltx-2.3-distilled-q8` |
| **LoRA Stage** | ✅ dev + distilled LoRA fusion | ❌ standalone（無 LoRA） |
| **Text Encoder** | `ltx-2.3-connector` | `ltx-2.3-connector` (共用) |
| **VAE** | `ltx-2.3-vae` | `ltx-2.3-vae` (共用) |
| **Spatial Upscaler** | x2 v1.1 | x2 v1.1 (共用) |
| **Audio** | `ltx-2.3-audio` | `ltx-2.3-audio` (共用) |
| **Steps** | 8–30（預設 8） | 8（baked sigmas） |
| **CFG** | 5.0（可調） | 1.0（無 guidance） |
| **STG** | 1.0 | 0.0（disabled） |
| **品質** | 較高 | 略低 |
| **速度** | 基準 | ~3-4× 更快 |
| **FLF2V** | ✅ | ❌（會幻覺） |
| **A2V** | ✅ | ✅ |
| **CLI 旗標** | （預設） | `--distilled` |

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

---

## Pipeline 支援矩陣

`LTXVideoPipeline` 封裝了 6 種 pipeline 模式。Dev 和 Distilled 使用不同的 transformer，共用所有周邊組件。

| 模式 | Vendor 類別 | CLI 旗標 | Transformer | 適用情境 |
|------|------------|---------|-------------|---------|
| **T2V** | `TI2VidTwoStagesPipeline` | （預設） | dev | 純文字生成影片 |
| **I2V** | `TI2VidTwoStagesPipeline` | `--input-image` | dev | 參考圖片生成影片 |
| **A2V** | `A2VidPipelineTwoStage` | `--audio` | dev | 音訊驅動影片 |
| **HQ** | `TI2VidTwoStagesHQPipeline` | `--hq` | dev | 高品質 T2V/I2V（res_2s 二階採樣） |
| **Distilled** | `DistilledPipeline` | `--distilled` | distilled v1.1 | 快速 T2V/I2V（8 步無 CFG） |
| **FLF2V** | `KeyframeInterpolationPipeline` | `--begin-image` + `--end-image` | dev | 首尾帧插值 |

### 模型格式說明

- **Q8 = MLX INT8**（不是 FP8）。`quantize_config.json` 記錄了量化格式（bits: 8, group_size: 64）
- FP8 只存在於 ComfyUI 脈絡（`fp8-mps-metal` MPS kernel patch），與此 MLX pipeline 無關
- `_resolve_safetensors()` 自動選擇最新版本化文件（如 `transformer-distilled-1.1.safetensors` 優先於 `transformer-distilled.safetensors`）

### Temporal Upscaler（2x 時間軸上採樣）

`temporal_upscaler_x2_v1_0`（250MB）：在 Stage 2 latent 空間插幀，F → 2F-1，生成更流暢的影片。

| 項目 | 說明 |
|------|------|
| 注入點 | `generate_two_stage()` 返回後、VAE decode 前（`_build_pipeline` 用 `_TemporalUpscaleMixin`） |
| 格式 | BCFHW latent；需先 `denormalize_latent()` → 上採樣 → `normalize_latent()` |
| CLI | `--temporal-upscale` / `--tu` |
| 適用模式 | T2V、I2V、HQ、FLF2V |
| 不支援 | A2V（audio token 數不隨之翻倍）、Distilled（尚未驗證） |
| 下載 | `python app/ltx_downloader.py`（已列為 optional） |

**spatial_upscaler_x1_5 不可 drop-in 替換 x2**：vendor 硬編碼 `H_half = height // 2`，x1.5 upsampler output 尺寸（H×0.75）無法匹配 Stage 2 期望的 H。需修改 vendor Stage 1 解析度計算才能啟用。

### 尚未實作的 vendor pipeline（可供未來擴充）

| 類別 | 說明 |
|------|------|
| `ICLoraPipeline` | 參考影片調節（IC-LoRA，一致角色跨場景） |
| `HDRICLoraPipeline` | HDR IC-LoRA（線性 HDR 輸出） |
| `RetakePipeline` | 局部片段重新生成（edit a time window） |
| `LipDubPipeline` | 唇型同步 |
| `TI2VidOneStagePipeline` | 單階段 dev（無 stage 2 upsampler） |

---

## FLF2V（首尾帧视频生成）

以首、尾兩張圖片為錨點，插值生成完整過渡影片。使用 `KeyframeInterpolationPipeline`（vendor 唯一的 keyframe 模式，無 HQ 變體）。

### 為什麼必須用 dev transformer？

蒸餾模型在 keyframe interpolation 時產生幻覺（亂生成不相關內容），vendor 強制要求使用 dev + CFG。

### 關鍵參數

| 參數 | FLF2V 預設 | T2V 預設 | 說明 |
|------|-----------|---------|------|
| `stage1_steps` | **20**（CLI 自動調整） | 8 | dev 模型需更多步 |
| `cfg_scale` | **3.0** | 5.0 | FLF2V 較低 CFG 效果更好 |
| `begin_strength` | 1.0 | — | 1.0 = 嚴格符合首帧 |
| `end_strength` | 1.0 | — | < 1.0 = 尾帧有彈性 |

### CLI 範例

```bash
# 基本
run.py video --begin-image start.png --end-image end.png \
  --prompt "smooth camera dolly between scenes" --frames 49

# 調整結尾自由度
run.py video --begin-image a.png --end-image b.png \
  --end-strength 0.8 --cfg-scale 3.0 --prompt "fluid motion"

# A/B 測試不同 end_strength
run.py video --begin-image a.png --end-image b.png \
  --prompt "walking transition" --variations 2 \
  --ab-params '{"end_strength":[1.0,0.7]}'

# 非互動 / 腳本（跳過確認提示）
run.py video --begin-image a.png --end-image b.png --prompt "..." --yes
```

### 注意事項

- `--teacache` 與 FLF2V 不相容（CLI 自動忽略並警告）
- `--begin-image` 與 `--input-image`、`--audio` 互斥
- 執行前 CLI 顯示確認提示；`--yes` / `-y` 可跳過

---

## Cross-References

- [`docs/ltx-pipeline.md`](../docs/ltx-pipeline.md) — Pipeline architecture, CLI reference, vendor patches
  - [§ Two-Stage Resolution Math](../docs/ltx-pipeline.md#two-stage-resolution-math) — spatial_upscaler_x2 timing, Stage 1 vs Stage 2 dims, 64-divisibility rule
- [`docs/flf2v-ltx2.3.md`](../docs/flf2v-ltx2.3.md) — FLF2V design lessons, parameters, performance benchmarks
  - [§ Dimension Decision from Reference Images](../docs/flf2v-ltx2.3.md#dimension-decision-from-reference-images) — how auto-fit works, full dimension table with concrete example
- [`docs/ltx-voice.md`](../docs/ltx-voice.md) — Audio investigation, A/B tests, Acelogic comparison
- [`vendor/ltx-2-mlx-dgrauet.README.md`](ltx-2-mlx-dgrauet.README.md) — Read-only reference copy of same upstream
- [`vendor/ltx-2-mlx-acelogic.README.md`](ltx-2-mlx-acelogic.README.md) — Acelogic fork (reference, text encoder comparison)
- [`vendor/mflux.README.md`](mflux.README.md) — mflux submodule notes
