# TODO — mlx-movie-director

## Done ✅

- [x] Z-Image Turbo text-to-image on Apple Silicon (MLX 4-bit, 14s for 9 steps)
- [x] Model conversion pipeline (convert.py: transformer + text encoder + tokenizer + VAE)
- [x] LoKR LoRA support (zit_sda_v1 diversity adapter)
- [x] 640×960 portrait generation matching moody-zimage-v7.5.json base stage

## Active / Next

### Phase 2: Upscaling (match moody flow stage 2–4)

The ComfyUI workflow does multi-stage upscaling after base generation:
- [x] **Stage 2**: LatentUpscaleBy 1.7× (bislerp) + KSampler refine (denoise ~0.5) → then VAEDecode
  - `--input-image BASE.png --latent-upscale 1.7 --denoise-strength 0.5`
  - Implemented in pipeline.py Phase 0 (VAE encode) + Phase 0.5 (latent upscale) + Phase 3 (img2img start step)
- [x] **Stage 3**: ImageUpscaleWithModel with `4xNomosWebPhoto_RealPLKSR.pth` → ×4 ESRGAN
  - `--upscale` flag, uses spandrel to load RealPLKSR model
  - Implemented in pipeline.py Phase 5

Full moody flow equivalent (chained):
```bash
# Step 1: base generation
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "..." --width 640 --height 960 --steps 9 --seed 42 \
  --lora-path comfyui_data/models/loras/zit_sda_v1.safetensors --lora-scale 0.49

# Step 2: latent refine → ESRGAN upscale
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "..." --input-image output/BASE.png \
  --latent-upscale 1.7 --denoise-strength 0.5 --upscale
```

Or in one pass (base generation + immediate ESRGAN):
```bash
./python/venv/bin/python python/mlx-movie-director/run.py \
  --prompt "..." --width 640 --height 960 --steps 9 --upscale
```

### Phase 3: Latent Refine (img2img)

- [x] `--input-image` flag + VAE encode → latent
- [x] `--latent-upscale FACTOR` — bilinear upscale latent before denoising
- [x] `--denoise-strength` — partial timestep start for img2img

### Phase 4: Prompt quality improvements

- [ ] Verify that Qwen3 chat template system prompt improves output quality
  - Currently uses `apply_chat_template(messages)` with user role only
  - Try adding a system prompt (e.g. "You are a creative visual artist...")
- [ ] Test negative prompt / CFG (unlikely supported by Turbo models but worth verifying)

### Phase 5: LoRA sweep / batch

- [x] Batch mode: `--count N --seed-start S` to generate N images with sequential seeds
- [ ] LoRA scale sweep script: compare effect of scale 0.0, 0.5, 0.8, 1.0, 1.2 in one command
  - Could be a small shell script wrapping run.py with different `--lora-scale` values

## Known Issues

### VAE invalid value warning
When LoKR is applied, pipeline.py sometimes shows:
`RuntimeWarning: invalid value encountered in cast`
**Fixed**: added `np.nan_to_num()` before PIL conversion (Phase 4).

### LoKR alpha interpretation
The `zit_sda_v1.safetensors` stores alpha=~1e10 (not a traditional LoRA alpha divisor).
Current fix: ignore alpha, apply delta as `kron(w1, w2) * user_scale`.
Moody flow ComfyUI applies this LoRA at model-sampler level — if effects look different,
revisit the scale formula.

### QKV fusion with LoRA
LoKR is applied to `to_q`, `to_k`, `to_v` individually, then `fuse_model()` merges them.
This is correct — the LoKR delta is baked into weights before fusion, so no interaction issue.

### img2img first JIT compile
The denoising step_fn is @mx.compile. On first img2img call (if resolution changed from
cache), it will recompile — expect 3–5s overhead on step 1.

## Ideas / Experiments

- **CFG / negative prompt**: test if the model supports classifier-free guidance (unlikely for Turbo)
- **Steps sweep**: compare 6, 9, 12 steps quality vs time
- **Resolution test**: try 768×1152, 512×768 to find optimal quality/speed tradeoff
- **Scheduler compare**: FlowMatchEuler vs FlowMatchEulerAncestral (add noise injection)
- **Memory profiling**: measure peak RAM per phase for 640×960 and 1024×1536
