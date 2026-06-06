# LoRA / LoKR 使用指南

## zit_sda_v1 — Z-Image Turbo Diversity Adapter

**格式**: LoKR (Kronecker LoRA，LyCORIS 格式)  
**用途**: 增加輸出多樣性，改變角色風格/構圖  
**路徑**: `comfyui_data/models/loras/zit_sda_v1.safetensors`

### 使用方法

```bash
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "YOUR PROMPT" \
  --width 640 --height 960 --steps 9 --seed 42 \
  --lora-path comfyui_data/models/loras/zit_sda_v1.safetensors \
  --lora-scale 0.49
```

> **Note**: moody-zimage-v7.5.json 中 `LoraLoaderModelOnly` 節點 strength = **0.49**（非 1.0）。

### LoKR 格式說明

LoKR 與標準 LoRA (lora_A/B) 不同：
- **標準 LoRA**: `ΔW = B @ A × (alpha/rank)` — 兩個低秩矩陣相乘
- **LoKR**: `ΔW = kron(lokr_w1, lokr_w2) × scale` — Kronecker 積

Kronecker 積 `kron([8×8], [480×480]) = [3840×3840]`，直接匹配模型的 attention 維度，
不需要低秩分解。

### Alpha 值的特殊情況

`zit_sda_v1.safetensors` 中的 alpha ≈ 9.999×10⁹（巨大值）。
這**不是**傳統 LoRA alpha（不能用 alpha/rank 作為 scale）。
正確做法：忽略 alpha，直接用 `kron(w1, w2) × user_scale`。

這是因為 w1/w2 在訓練時已經 pre-scaled：
- Base weight std ≈ 0.165
- kron delta std ≈ 0.00069（約基礎權重的 0.4%，合理的微調幅度）

### 套用機制

1. 計算 Kronecker product: `ΔW = kron(w1, w2) × user_scale`
2. 對每個目標層的量化權重：dequantize → 加 ΔW → requantize
3. 套用完後執行 QKV fusion（fuse_model()）
4. 目標：layers 0–9 的 attention (Q/K/V/out)、feed_forward (w1/w2/w3)、adaLN_modulation

### Key 命名對應

| LoKR 檔案 key | MLX 模型 path |
|--------------|--------------|
| `diffusion_model.layers.N.attention.to_q` | `layers.N.attention.to_q` |
| `diffusion_model.layers.N.attention.to_out.0` | `layers.N.attention.to_out` |
| `diffusion_model.layers.N.adaLN_modulation.0` | `layers.N.adaLN_modulation` |
| `diffusion_model.layers.N.feed_forward.w1` | `layers.N.feed_forward.w1` |

## 標準 LoRA 支援

`lora_utils.py` 同時支援傳統 LoRA 格式 (`lora_A/B` 或 `lora_down/up`)，
用 `LoRALinearWrapper` 在推論時動態加入。LoKR 則是 bake 進量化權重。

## 加入其他 LoRA

支援 ComfyUI 標準的 LoRA `.safetensors` 檔案。key 命名會自動轉換。
如果有 naming mismatch，在 `app/lora_utils.py` 的 `_convert_lokr_key()` 或
`convert_unet_key_to_mlx()` 中新增對應規則。
