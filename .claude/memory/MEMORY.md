# Project Memory Index

Persistent lessons learned across Claude Code sessions for this ComfyUI on Apple Silicon project.

## Entries

### [FP8 Compute MPS Incompatible](fp8-compute-mps-incompatible.md)
`--supports-fp8-compute` must NOT be used in run.sh on Apple Silicon. The flag tells ComfyUI to use FP8 quantized matmul via `torch._scaled_mm_v2`. On MPS this operator is unsupported and falls back to CPU, where it crashes with `ValueError: Invalid scaling configuration` (mat_a is Byte, mat_b is Float8_e4m3fn). All our models (Flux 2 Klein bf16, Moody fp16, LTX-2.3 bf16) run fine without it.

### [SeedVR2 Offload Device MPS](seedvr2-offload-device-mps.md)
SeedVR2 on Apple Silicon MPS: `offload_device` must be `"none"` (NOT `"cpu"`). The SeedVR2 `get_device_list()` function explicitly excludes `"cpu"` on MPS-only systems because unified memory makes CPU offloading meaningless. Settings: device=mps, offload_device=none, cache_model=False, blocks_to_swap=0, attention_mode=sdpa.

### [Flux2 Klein Face/Head Swap](flux2-klein-face-head-swap.md)
Face/head swap workflow: PainterFluxImageEdit takes source person → bald generation → AutoCropFaces → face/head swap. Key fix: original prompts said "remove the hair" causing bald results. Fixed to "replace the person's face in Image 1 with the face from Image 2, while keeping the natural hairstyle of Image 1". Also fixed SeedVR2 offload_device config.

## Quick Reference: MPS Constraints

| Constraint | Details |
|---|---|
| No FP8 compute | `--supports-fp8-compute` → ValueError on MPS |
| No CUDA attention | SageAttention ❌, Flash Attention ❌ — SDPA only |
| Triton is stub | `scripts/install_stubs.sh` — import works, kernels don't |
| No FP8 models | All safetensors must be bf16/fp16 |
| SeedVR2 settings | device=mps, offload_device=none, cache_model=False, attention_mode=sdpa |
| Face Detailer | Bypassed — MPS VAE INT_MAX tensor dim limit |
| Filename tokens | Use `%year%-%month%-%day%` etc., NOT `%date:...%` |
