---
name: fp8-compute-mps-incompatible
description: "--supports-fp8-compute flag breaks ComfyUI on Apple Silicon MPS"
metadata:
  node_type: memory
  type: feedback
---

**`--supports-fp8-compute` must NOT be used in run.sh on Apple Silicon.**

The flag tells ComfyUI to use FP8 quantized matmul via `torch._scaled_mm_v2`. On MPS this operator is unsupported and falls back to CPU, where it crashes with `ValueError: Invalid scaling configuration` (mat_a is Byte, mat_b is Float8_e4m3fn).

**Why:** `torch._scaled_mm_v2` is NVIDIA-only (compute capability ≥ 8.9). MPS has no native FP8 compute. All our models (Flux 2 Klein bf16, Moody fp16, LTX-2.3 bf16) run fine without it.

**How to apply:** Keep `--supports-fp8-compute` out of run.sh. If someone suggests adding it for performance, refuse — it will crash every FLUX/LTX inference on MPS. A comment in run.sh already warns about this.

[[seedvr2-offload-device-mps]]
