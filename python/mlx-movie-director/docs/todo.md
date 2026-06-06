# TODO — mlx-movie-director

## Done ✅

- [x] Z-Image Turbo text-to-image on Apple Silicon (MLX 4-bit, 14s for 9 steps)
- [x] Model conversion pipeline (convert.py: transformer + text encoder + tokenizer + VAE)
- [x] LoKR LoRA support (zit_sda_v1 diversity adapter)
- [x] 640×960 portrait generation matching moody-zimage-v7.5.json base stage

## Active / Next

### Phase 2: Upscaling (match moody flow stage 2–4)

The ComfyUI workflow does multi-stage upscaling after base generation:
- **Stage 2**: LatentUpscaleBy 1.7× (bislerp) + KSampler refine (denoise ~0.5) → then VAEDecode
- **Stage 3**: ImageUpscaleWithModel with `4xNomosWebPhoto_RealPLKSR.pth` → ×2 real-ESRGAN

For the MLX pipeline, the simplest approach:
1. Add `--upscale` flag to run.py that applies PIL-based 2× upscale after VAE decode
2. Or integrate a lightweight ESRGAN (spandrel/basicsr) using the existing .pth model

Model at: `comfyui_data/models/upscale_models/4xNomosWebPhoto_RealPLKSR.pth`

### Phase 3: Latent Refine (img2img)

For stage 2 latent upscale + re-denoise, need to add:
- `--input-image` flag to pipeline (encode to latent, denoise from strength)
- Or accept `--latent` directly (skip VAE encode, refine in latent space)

### Phase 4: Prompt quality improvements

The ComfyUI moody flow uses the Qwen3 chat template with specific system/user prompt structure.
Currently pipeline.py applies `apply_chat_template` which should work. Verify:
- Does using a system prompt improve output quality?
- Try negative prompt support (classifier-free guidance, if model supports it)

### Phase 5: LoRA sweep / batch

- Add `--lora-scale` sweep to compare 0.0, 0.5, 0.8, 1.0, 1.2 effect of zit_sda_v1
- Add batch mode: `--count N --seed-start S` to generate N images with sequential seeds

## Known Issues

### LoKR alpha interpretation
The `zit_sda_v1.safetensors` stores alpha=~1e10 (not a traditional LoRA alpha divisor).
Current fix: ignore alpha, apply delta as `kron(w1, w2) * user_scale`.
Moody flow ComfyUI applies this LoRA at model-sampler level — if effects look different,
revisit the scale formula.

### VAE invalid value warning
When LoKR is applied, pipeline.py line 283 sometimes shows:
`RuntimeWarning: invalid value encountered in cast`
This may indicate some NaN pixels from the requantize round-trip. Add `nan_to_num` before
the PIL conversion if this causes visible artifacts.

### QKV fusion with LoRA
LoKR is applied to `to_q`, `to_k`, `to_v` individually, then `fuse_model()` merges them.
This is correct — the LoKR delta is baked into weights before fusion, so no interaction issue.

## Ideas / Experiments

- **CFG / negative prompt**: test if the model supports classifier-free guidance (unlikely for Turbo)
- **Steps sweep**: compare 6, 9, 12 steps quality vs time
- **Resolution test**: try 768×1152, 512×768 to find optimal quality/speed tradeoff
- **Scheduler compare**: FlowMatchEuler vs FlowMatchEulerAncestral (add noise injection)
- **Memory profiling**: measure peak RAM per phase for 640×960 and 1024×1536
