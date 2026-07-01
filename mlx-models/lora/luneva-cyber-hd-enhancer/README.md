# Luneva Cyber HD Enhancer — ZImageTurbo LoRA

**Source**: https://civitai.com/models/2215818/luneva-cyber-hd-enhancer  
**Version**: 21000S/1536px/R128 v1 (modelVersionId=2494657)  
**Base model**: ZImageTurbo  
**Format**: safetensors BF16, R128, trained at 1536px for 21000 steps  
**File**: `ZIT_Luneva_CyberHD.safetensors` (~648 MB)

## Purpose

HD detail enhancer LoRA in the Luneva style — adds cyber/photorealistic detail enhancement.
Pairs well with `midjourney-luneva-cinematic-lora` for stacked Luneva effects.

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --prompt "your prompt" \
  --lora-path python/mlx-movie-director/models/lora/luneva-cyber-hd-enhancer/ZIT_Luneva_CyberHD.safetensors \
  --lora-scale 0.8
```

## Recommended settings

| Parameter | Value |
|-----------|-------|
| `--lora-scale` | 0.6–1.0 (default 0.8) |
| Resolution | 1024×1536 or 1536×1024 (trained at 1536px) |
| Pipeline | `zimage-turbo` (moody-v12.6) |

## Compatibility

- `transformer/moody-pro-mix` ✅
- Flux2 Klein / LTX: ❌ (different architecture)
