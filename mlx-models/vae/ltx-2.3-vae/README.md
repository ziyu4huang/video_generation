# ltx-2.3-vae — LTX-2.3 Video VAE

HF repo: `dgrauet/ltx-2.3-mlx-q8`

## 包含文件

| 檔案 | 大小 | 說明 |
|------|------|------|
| `vae_encoder.safetensors` | 608 MB | 視頻 VAE 編碼器（latent 正規化統計） |
| `vae_decoder.safetensors` | 777 MB | 視頻 VAE 解碼器（streaming decode） |
| `spatial_upscaler_x2_v1_1.safetensors` | 950 MB | Stage 1→2 空間 2x 上採樣器（pipeline 自動使用） |
| `spatial_upscaler_x2_v1_1_config.json` | — | 上採樣器架構設定 |
| `spatial_upscaler_x1_5_v1_0.safetensors` | 1.02 GB | 空間 1.5x 上採樣器（暫未整合，需改 vendor Stage 1 解析度） |
| `spatial_upscaler_x1_5_v1_0_config.json` | — | 上採樣器架構設定 |
| `temporal_upscaler_x2_v1_0.safetensors` | 250 MB | 時間軸 2x 上採樣器（F → 2F-1 幀，CLI: `--temporal-upscale`） |
| `temporal_upscaler_x2_v1_0_config.json` | — | 上採樣器架構設定 |

## 使用說明

所有 upscaler 都在 `_assemble_flat_dir()` symlink 時自動加入 flat dir。
- **spatial x2**：所有 two-stage pipeline（T2V / I2V / HQ / FLF2V）在 Stage 1→2 之間自動使用
- **temporal x2**：用 `--temporal-upscale` / `--tu` 啟用，在 Stage 2 latent 空間插幀後再 decode
- **spatial x1.5**：已下載但暫不可用（vendor 硬編碼 `H_half = height // 2`，x1.5 輸出尺寸不匹配 Stage 2）
