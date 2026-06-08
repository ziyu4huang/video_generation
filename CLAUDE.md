# Video Generation — ComfyUI on Apple Silicon

Project-level instructions for Claude Code sessions working on this ComfyUI setup.

## Communication

- **Conversation language**: 繁體中文 (zh_TW) — use zh_TW for discussion, explanations, and Q&A
- **Written output**: English — all docs, code comments, commit messages, and file content in English

## Python — Always Use Project Venv

**RULE: Every Python command in this repo MUST use the ComfyUI venv.**

```bash
# Correct — always use this path:
ComfyUI/.venv/bin/python script.py
ComfyUI/.venv/bin/python -c "import torch; ..."

# WRONG — never use these:
python3 script.py          # system Python 3.9, lacks project deps
python3.13 script.py       # uv-managed, pip install fails (PEP 668)
```

- Venv is at `ComfyUI/.venv/` — Python 3.13.13, same as `run.sh`
- Has all deps: torch, safetensors, websocket-client, requests, etc.
- Never install packages into brew Python — it's externally managed by uv

## Platform: Apple Silicon MPS

All workflows run on **Apple Silicon (MPS backend)**. This constrains what works:

- **FP8 supported via patch**: `--supports-fp8-compute` is active in `run.sh`. The `fp8-mps-metal` custom node patches `comfy_kitchen.scaled_mm_v2` to route MPS+FP8 ops to Metal GPU kernels, fixing the original `ValueError: Invalid scaling configuration`. See `docs/fp8-mps-apple-silicon.md`.
- **No CUDA-only attention**: SageAttention, Flash Attention, xformers — all require CUDA. SDPA is the only option on MPS.
- **Triton is a stub**: `scripts/install_stubs.sh` creates a fake `triton` package so RMBG-SAM3 and torch._inductor load without errors. It does nothing at runtime.
- **FP8 model loading works**: `fp8-mps-metal` stores FP8 weights as uint8 on MPS (same bit pattern), handles quantize/dequantize via Metal GPU kernels.
- **Face DetailerForEach bypassed**: MPS VAE attention hits INT_MAX tensor dim limit on large face crops.

## Startup

```bash
./run.sh          # starts ComfyUI on http://127.0.0.1:8188
```

`run.sh` handles: venv bootstrap, platform stubs, git patches, MPS env vars (`PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`, `PYTORCH_ENABLE_MPS_FALLBACK=1`).

## Workflows

| # | Name | File | Models |
|---|---|---|---|
| 1 | Anime → Real Style Transfer | `flux2-klein9b.json` | Flux 2 Klein 9B bf16 + anything2real LoRA |
| 2 | Multi-Pose Character Sheet | `anime2real.json` | Flux 2 Klein 9B bf16 |
| 3 | LTX-2.3 Video Generation | `ltx2.3-singularity.json` | LTX-2.3 22B bf16 + Singularity LoRA |
| 4 | Moody Zimage Photorealistic | `moody-zimage-v7.5.json` | Moody V12.6 DPO + SeedVR2 7B |

## Key Directories

```
ComfyUI/                          # submodule (not fully committed)
comfyui_data/models/              # ~90GB models (gitignored)
comfyui_data/custom_nodes/        # cloned packages (gitignored except stubs)
comfyui_data/user/default/workflows/  # workflow JSONs (committed)
patches/comfyui/                  # git patches applied on startup
scripts/install_stubs.sh          # triton + decord stubs for macOS
```

## Known Issues & Fixes

See [`.claude/memory/MEMORY.md`](.claude/memory/MEMORY.md) for the full index of lessons learned across sessions (FP8, SeedVR2 MPS config, prompt tuning, etc.).

## Patches

Git patches in `patches/comfyui/` are auto-applied by `run.sh`:
- MPS fp8 safety in `comfy/model_management.py`
- MPS quantized module fix in `comfy/ops.py`

## Filename Tokens

ComfyUI built-in tokens for SaveImage `filename_prefix`: `%year%`, `%month%`, `%day%`, `%hour%`, `%minute%`, `%second%`, `%width%`, `%height%`. The `%date:...%` syntax is from the pysssss plugin and won't resolve without it.
