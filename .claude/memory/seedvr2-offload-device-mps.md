---
name: seedvr2-offload-device-mps
description: "SeedVR2 offload_device must be \"none\" (not \"cpu\") on Apple Silicon MPS"
metadata:
  node_type: memory
  type: feedback
---

SeedVR2 on Apple Silicon MPS: `offload_device` must be `"none"` (NOT `"cpu"`). The SeedVR2 `get_device_list()` function explicitly excludes `"cpu"` on MPS-only systems because unified memory makes CPU offloading meaningless.

**Why**: The code at `memory_manager.py:89` checks `if include_cpu and (has_cuda or not has_mps)` — so `"cpu"` is only available when CUDA is present. On MPS, valid options are `["none", "mps"]`.

**How to apply**: For all SeedVR2 nodes (DiT loader, VAE loader, Upscaler) on Apple Silicon:
- `device`: `"mps"`
- `offload_device`: `"none"`
- `cache_model`: `False` (required when offload_device="none")
- `blocks_to_swap`: `0` (auto-disabled on unified memory)
- `attention_mode`: `"sdpa"` (only MPS-compatible mode)

⚠️ **Previous fix was wrong**: Earlier we set `offload_device="cpu"` to avoid the `cache_model=True` ValueError. But `"cpu"` is not a valid option on MPS. The correct fix is `offload_device="none"` with `cache_model=False`.

**Reference**: SeedVR2 `memory_manager.py` lines 48-90.

### Related
- [[flux2-klein-face-head-swap]]
