# FP8 on Apple Silicon MPS — Technical Deep Dive

How FP8 model inference (`float8_e4m3fn`) was made to work on Apple Silicon MPS, including the root cause, the fix, and the implementation details.

---

## Problem Statement

Apple Silicon MPS does **not** support `torch.float8_e4m3fn` dtype natively. This affects:
- Storing FP8 model weights on the MPS device
- Running FP8 matmul operations (`torch._scaled_mm_v2`)
- ComfyUI's `comfy_kitchen` quantization dispatch

---

## Stack Trace of the Original Error

```
ValueError: Invalid scaling configuration
  mat_a.dtype()=Byte, mat_b.dtype()=Float8_e4m3fn
```

Caused by: `torch.nn.functional.scaled_mm` (v2 API) → `torch._scaled_mm_v2`, which validates that both inputs are float8 dtypes. Neither `uint8` (Byte) nor mixed float8/uint8 is accepted.

### Why the built-in fallback didn't fire

`comfy_kitchen`'s `_handle_fp8_linear` has:
```python
except (RuntimeError, TypeError):
    # fallback ...
```

`ValueError` is not caught, so the error propagates unhandled.

---

## How `--supports-fp8-compute` Works

When `run.sh` passes `--supports-fp8-compute` to ComfyUI, `comfy/ops.py` does this at model load time:

```python
# ops.py lines ~1087-1128 (simplified)
if _mps_fp8_compute and module.quant_format in FP8_FORMATS:
    weight_for_storage = weight.cpu().to(fp8_dtype).view(torch.uint8).to(device)
```

The FP8 bit pattern is preserved, just stored under `torch.uint8` dtype — the only 8-bit dtype MPS supports. This halves the memory footprint compared to casting to float16.

---

## The Fix: `fp8-mps-metal` Custom Node

Located at: `comfyui_data/custom_nodes/fp8-mps-metal/`

### Three patches applied at startup

**1. `_patch_scaled_mm_v2()` — the critical fix**

Patches `comfy_kitchen.scaled_mm_v2.scaled_mm_v2` (the function comfy_kitchen calls before `torch._scaled_mm_v2`). Intercepts calls where `input.device.type == 'mps'` and `input.dtype in (uint8, float8_e4m3fn, float8_e5m2)`.

Flow:
```
comfy_kitchen._handle_fp8_linear
  → comfy_kitchen.scaled_mm_v2.scaled_mm_v2  ← PATCHED HERE
    ↓ MPS+uint8 path:
    convert both inputs to uint8 on MPS
    B = weight.t().contiguous()  # (N,K) for Metal kernel
    fp8_mps_native.fp8_scaled_mm_auto(A_u8, B_u8, sa, sb)
    ↓ fallback if Metal fails:
    move to CPU, view as float8_e4m3fn, call original, return to MPS
```

**2. `_patch_scaled_mm_legacy()` — backward compatibility**

Patches `torch._scaled_mm` via the old `fp8_mps_patch.py`. For older comfy_kitchen versions.

**3. `_patch_comfy_kitchen()` — quantize/dequantize**

Patches `comfy_k.quantize_per_tensor_fp8` and `comfy_k.dequantize_per_tensor_fp8`:
- **Quantize**: CPU → float8 → view(uint8) → move to MPS
- **Dequantize**: MPS uint8 → Metal GPU kernel (`fp8_mps_native.fp8_dequantize`) → fallback: CPU roundtrip

---

## Metal GPU Kernels (`fp8_matmul.metal`)

Compiled via `torch.mps.compile_shader()` (zero-copy, no C++ extension needed).

| Kernel | Use Case | Algorithm |
|---|---|---|
| `fp8_scaled_matmul_kernel` | General M×K @ K×N | Per-element FP8 decode + accumulate |
| `fp8_scaled_vecmat_kernel` | Single token (M=1) | SIMD reduction, 32 threads per output |
| `fp8_to_half_kernel` | FP8 → FP16 dequant | IEEE-754 bit extraction |
| `float_to_fp8_kernel` | Float → FP8 quant | Clamp + round to e4m3fn range |

For M > 16, `fp8_scaled_mm_auto` routes to the "fast" path: dequant A and B to FP16 on GPU, then run native FP16 matmul on the hardware matrix engine (AMX). This leverages Apple's optimized FP16 GEMM while still loading weights at FP8 bandwidth.

---

## FP8 e4m3fn Format

```
Bit layout: S EEEE MMM
  S = sign (1 bit)
  E = exponent (4 bits), bias = 7
  M = mantissa (3 bits)

Range: -448.0 to +448.0
Max representable: 448.0 (01111110)
Special: NaN = 01111111, no infinity
```

Compared to BF16:
- Dynamic range: BF16 has 8 exponent bits (same as FP32), FP8 has only 4
- Precision: BF16 has 7 mantissa bits, FP8 has only 3
- Memory: FP8 = 1 byte/weight, BF16 = 2 bytes/weight

---

## Memory Savings

For Flux 2 Klein 9B:

| Component | BF16 | FP8 |
|---|---|---|
| Diffusion model | 17 GB | 8.8 GB |
| CLIP (shared) | 8.1 GB | 8.1 GB |
| VAE (shared) | 0.3 GB | 0.3 GB |
| **Total** | **~25.4 GB** | **~17.2 GB** |
| **Savings** | — | **−8.2 GB (−32%)** |

---

## Quantization Error

Per-tensor FP8 quantization introduces a small but measurable error:
- Single layer dequantize max error: `< 0.001` (tested, max observed: `0.000010`)
- Multi-layer perceptual quality loss: typically < 1 PSNR, imperceptible to human eye

---

## Required Configuration

```bash
# run.sh must include:
--supports-fp8-compute          # store FP8 weights as uint8 on MPS

# env vars (also in run.sh):
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0
export PYTORCH_ENABLE_MPS_FALLBACK=1

# custom node must be present:
comfyui_data/custom_nodes/fp8-mps-metal/
```

---

## Debugging

If FP8 breaks, check ComfyUI startup log for:
```
[fp8-mps-metal] comfy_kitchen.scaled_mm_v2 已 patch → MPS Metal GPU + CPU fallback
[fp8-mps-metal] torch._scaled_mm 已 patch → Metal GPU（舊版相容）
[fp8-mps-metal] comfy_kitchen 頂層 FP8 量化/反量化已 patch（MPS uint8 模式）
```

All three lines must appear. If `comfy_kitchen.scaled_mm_v2` patch is missing, FP8 inference will fail with `ValueError`.
