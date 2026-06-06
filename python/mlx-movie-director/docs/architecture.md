# Z-Image Turbo MLX Architecture Notes

## Model Architecture

Z-Image Turbo is a flow-matching diffusion transformer (similar to Flux/DiT family).

```
Input: noise latents [1, 16, H/8, W/8]
  ↓
Patchify: 2×2 spatial patches → tokens [1, H_tok*W_tok, 16*4]
  ↓
x_embedder (Linear): patch tokens → dim=3840
  ↓
cap_embedder (RMSNorm + Linear): text embed (2560) → dim=3840
  ↓
noise_refiner (2 blocks, with adaLN): refine image tokens only
context_refiner (2 blocks, no adaLN): refine text tokens only
  ↓
30 × ZImageTransformerBlock (full attention, adaLN):
  - Unified attention over [image_tokens + text_tokens]
  - RoPE positional encoding (3D: frame, height, width)
  - FeedForward: SwiGLU (w1, w2, w3)
  ↓
final_layer (LayerNorm + Linear): → [1, H_tok*W_tok, 16*4]
  ↓
Unpatchify → latents [1, 16, H/8, W/8]
  ↓
VAE decode (AutoencoderKL, PyTorch on MPS) → PIL Image
```

## Key Config Values

```python
TRANSFORMER_CONFIG = {
    "dim": 3840,           # hidden dimension
    "n_heads": 30,         # attention heads (head_dim = 128)
    "n_layers": 30,        # main transformer blocks
    "n_refiner_layers": 2, # noise + context refiner blocks
    "in_channels": 16,     # VAE latent channels
    "cap_feat_dim": 2560,  # text encoder output dim (Qwen3-4B)
    "axes_dims": [32, 48, 48],   # RoPE dims per axis (temporal, height, width)
    "axes_lens": [1536, 512, 512],
    "rope_theta": 256.0,
}
```

## ComfyUI → MLX Key Remapping (convert.py)

The ComfyUI checkpoint uses different naming conventions from the MLX model:

| ComfyUI key | MLX key |
|-------------|---------|
| `model.diffusion_model.all_x_embedder.2-1.weight` | `x_embedder.weight` |
| `model.diffusion_model.all_final_layer.2-1.linear.weight` | `final_layer.linear.weight` |
| `model.diffusion_model.t_embedder.mlp.0.weight` | `t_embedder.linear1.weight` |
| `model.diffusion_model.t_embedder.mlp.2.weight` | `t_embedder.linear2.weight` |
| `model.diffusion_model.*.attention.qkv.weight` | Split into `to_q`, `to_k`, `to_v` |
| `model.diffusion_model.*.attention.out.weight` | `*.attention.to_out.weight` |
| `model.diffusion_model.*.attention.q_norm.weight` | `*.attention.norm_q.weight` |
| `model.diffusion_model.*.attention.k_norm.weight` | `*.attention.norm_k.weight` |
| `model.diffusion_model.cap_embedder.0.weight` | `cap_embedder.layers.0.weight` |
| `model.diffusion_model.cap_embedder.1.weight` | `cap_embedder.layers.1.weight` |
| `model.diffusion_model.*.adaLN_modulation.1.weight` | `*.adaLN_modulation.layers.1.weight` |

## Scheduler: FlowMatch Euler with Dynamic Time-Shifting

Z-Image Turbo uses flow-matching (not DDPM). The scheduler:
- Timesteps linearly spaced from 1.0 → 0.0 (N+1 points, N steps)
- Dynamic mu-shifting based on image sequence length
- `mu = calculate_shift(H_tok * W_tok)` — larger images use larger shift
- Euler step: `x_{t-1} = x_t + (t_prev - t_curr) * model_output`
- **Note**: model outputs `-velocity`, so the negative sign in pipeline.py line 240 is intentional

## Positional Encoding

3D RoPE (Rotary Position Embedding) over three axes: frame (temporal), height, width.

- Coordinate grid: `create_coordinate_grid((1, H_tok, W_tok), start=(cap_seq_len+1, 0, 0))`
- Unified sequence: image tokens + caption tokens with separate positions
- RoPE dimensions split: `axes_dims = [32, 48, 48]` → per-axis frequencies
- Cached per (width, height, cap_seq_len) — reused across steps

## Quantization Details

- **Format**: 4-bit with group_size=32 (MLX `nn.quantize`)
- **Transformer**: ~3.6 GB (from ~11 GB source)
- **Text encoder**: ~2.3 GB (from ~7.5 GB source)
- **Load strategy**: pre-quantize model structure, then load quantized weights (fast)
- **QKV fusion**: after loading, `to_q/k/v` fused into `to_qkv` for inference speed

## LoRA Format: LoKR (Kronecker LoRA)

The `zit_sda_v1.safetensors` diversity adapter uses **LoKR** format, not standard LoRA:
- Keys: `diffusion_model.layers.N.module_name.lokr_w1/w2/alpha`
- Delta: `ΔW = kron(lokr_w1, lokr_w2) × (alpha / rank)` where rank = lokr_w1.shape[0]
- Targets: layers 0–9 (of 30), attention Q/K/V/out, feed_forward w1/w2/w3, adaLN_modulation
- Application: dequantize base weight → add ΔW → requantize (baked into weights before QKV fusion)

Key shape examples (rank=8):
- `attention.to_q`: lokr_w1=[8,8], lokr_w2=[480,480] → ΔW=[3840,3840]
- `adaLN_modulation`: lokr_w1=[8,8], lokr_w2=[1920,32] → ΔW=[15360,256]
- `feed_forward.w1`: lokr_w1=[8,8], lokr_w2=[1280,480] → ΔW=[10240,3840]
