# Flux 2 Klein 9B：BF16 vs FP8 比較（Apple Silicon）

本文比較在 Apple Silicon（MPS）上執行 Flux 2 Klein 9B 的兩種精度版本。

---

## 模型檔案大小

| 模型檔案 | 精度 | 檔案大小 | 每參數位元組 |
|---|---|---|---|
| `flux-2-klein-9b-bf16.safetensors` | BF16 | **17 GB** | 2 bytes |
| `flux-2-klein-9b-fp8.safetensors` | FP8 (e4m3fn) | **8.8 GB** | 1 byte |

FP8 版本節省了 **48%** 的儲存空間（8.2 GB）。

---

## 完整載入記憶體估算

兩個工作流程共用相同的 CLIP 與 VAE：

| 元件 | 模型 | 大小 |
|---|---|---|
| Text Encoder (CLIP) | `qwen_3_8b_fp8mixed.safetensors` | 8.1 GB |
| VAE | `flux2-vae.safetensors` | 321 MB |

| 配置 | Diffusion Model | CLIP | VAE | **合計** |
|---|---|---|---|---|
| BF16 | 17 GB | 8.1 GB | 0.3 GB | **≈ 25.4 GB** |
| FP8 | 8.8 GB | 8.1 GB | 0.3 GB | **≈ 17.2 GB** |
| **節省** | **-8.2 GB** | — | — | **-8.2 GB (−32%)** |

---

## 數值格式技術差異

### BF16（bfloat16）
```
符號 1 bit | 指數 8 bit | 尾數 7 bit  = 16 bit (2 bytes)
```
- 動態範圍與 FP32 相同（指數位元數一致）
- 直接在 MPS 上執行，無需額外處理

### FP8 e4m3fn（float8_e4m3fn）
```
符號 1 bit | 指數 4 bit | 尾數 3 bit  = 8 bit (1 byte)
```
- 最大可表示值：448（相較 BF16 的 ~3.4×10³⁸）
- 量化誤差比 BF16 更高，但在推論中影響有限
- **Apple Silicon（MPS）限制**：MPS 不支援 float8 dtype，需要特殊處理

---

## Apple Silicon FP8 技術實作

### 問題
MPS 不支援 `torch.float8_e4m3fn` dtype，導致：
1. 模型無法直接載入到 MPS 裝置
2. `comfy_kitchen` 的 dequantize 底層走 `torch.ops` dispatch，拒絕 uint8 dtype

### 解決方案

**1. `--supports-fp8-compute` 旗標**（`run.sh`）

啟用後，`ops.py` 將 FP8 權重以 **uint8 格式** 儲存在 MPS 上（位元模式相同，只換 dtype 標籤）：

```python
# ops.py（簡化）
if _mps_fp8_compute and module.quant_format in FP8_FORMATS:
    weight_for_storage = weight.cpu().to(fp8_dtype).view(torch.uint8).to(device)
```

**2. `fp8-mps-metal` custom node**（`comfyui_data/custom_nodes/fp8-mps-metal/`）

攔截兩個關鍵函數（頂層 module attribute，在 `torch.ops` dispatch 之前）：

```
comfy_kitchen.quantize_per_tensor_fp8
  → MPS: CPU 量化 → float8 → view(uint8) → 移至 MPS

comfy_kitchen.dequantize_per_tensor_fp8
  → MPS + uint8 input: 嘗試 Metal GPU kernel（fp8_mps_native）
    → fallback: CPU roundtrip（uint8 → float8_e4m3fn → 原函數 → 移回 MPS）
```

**3. Metal GPU Kernel**（`fp8_matmul.metal`）

透過 `torch.mps.compile_shader()` 編譯，提供：
- `fp8_to_half_kernel`：FP8 → FP16 dequantize（MPS 上零拷貝）
- `fp8_scaled_matmul_kernel`：FP8 scaled matmul（M > 16 時）
- `fp8_scaled_vecmat_kernel`：FP8 vecmat（M == 1，單 token 推論最佳化）

---

## 工作流程差異

| 項目 | BF16 工作流程 | FP8 工作流程 |
|---|---|---|
| 工作流程 ID | `f7a950e7-...` | `2bb9b586-...` |
| 工作流程檔案 | `flux2-klein9b.json` | `flux2-klein9b-fp8.json` |
| UNETLoader 模型 | `flux-2-klein-9b-bf16.safetensors` | `flux-2-klein-9b-fp8.safetensors` |
| weight_dtype | `default` | `default` |
| CLIP 模型 | `qwen_3_8b_fp8mixed.safetensors` | `qwen_3_8b_fp8mixed.safetensors` |
| VAE 模型 | `flux2-vae.safetensors` | `flux2-vae.safetensors` |
| 取樣器 | `er_sde` | `er_sde` |
| 步數 | 4 | 4 |
| CFG | 1 | 1 |
| 輸出前綴 | `ComfyUI` | `Klein9B-fp8` |

節點結構、解析度設定、ControlNet 配置**完全相同**，僅 diffusion model 替換。

---

## 品質 vs 效能預期

### 精度損失
FP8 e4m3fn 相對 BF16 的量化誤差：
- 單層 dequantize 誤差：**< 0.001**（實測最大誤差 0.000010）
- 多層累積後的感知品質差異：通常 **< 1 PSNR**，肉眼難以分辨

### 記憶體優勢（Apple Silicon）
- 節省 **8.2 GB** unified memory（Diffusion Model 部分）
- M4 Pro 64GB → 可省出更多空間給 KV cache 與 latent
- 有效延長可處理的最大解析度上限

### 速度
FP8 的理論優勢：
- Diffusion Model 讀取頻寬需求減半（8.8 GB vs 17 GB）
- Metal matmul kernel 在 M 系列 GPU 上以 FP16 執行（dequant 後），受益有限
- 實際速度差異主要來自**記憶體頻寬**，不是計算量

> 實際推論速度數據尚待測量（FP8 首次推論包含 shader 編譯時間）。

---

## 需要的環境條件

```bash
# run.sh 必須包含
--supports-fp8-compute          # 啟用 MPS uint8 FP8 儲存

export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0
export PYTORCH_ENABLE_MPS_FALLBACK=1
```

```
# 必要的 custom node
comfyui_data/custom_nodes/fp8-mps-metal/   # 攔截 comfy_kitchen FP8 dispatch
```

---

## 何時選擇哪個版本

| 情境 | 建議 |
|---|---|
| 記憶體 ≤ 24 GB，需同時跑其他模型 | **FP8** |
| 追求最高影像品質、記憶體充足 | **BF16** |
| 一般創作使用（品質要求中等） | **FP8**（節省 8 GB，品質差異不明顯） |
| Debug / 比較基準 | **BF16**（行為最可預測） |
