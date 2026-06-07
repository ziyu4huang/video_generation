# Z-Image Turbo Fun ControlNet Union 2.0

**Source**: https://civitai.com/models/2192289/zimageturbo-controlnet-6g-vram-can-run-it?modelVersionId=2509261

Union-style ControlNet for Z-Image Turbo. Supports multiple preprocessor types (pose, depth, canny, hed, scribble) via a 4-dim type indicator embedded at inference time.

## Architecture

- `control_all_x_embedder["2-1"]`: Projects concatenated 132-dim input (64 noise + 64 control + 4 union type) → 3840-dim
- `control_noise_refiner[0,1]`: 2 refinement blocks
- `control_layers[0..14]`: 15 control blocks, each with `before_proj` + transformer block + `after_proj`

Residuals from the 15 control layers inject into the main ZImage transformer's 30 layers at stride-2 (control layer `i` → main layer `2i`).

## Usage

```bash
python/venv/bin/python python/mlx-movie-director/run.py image controlnet \
  --input-image output/ref.png \
  --prompt "背面拍摄，高清摄影。一个coser少女，她cos的是雷姆。" \
  --controlnet-type canny \
  --controlnet-strength 0.9 \
  --steps 9
```

## Model file

`model.safetensors` is a symlink to `comfyui_data/models/model_patches/Z-Image-Turbo-Fun-Controlnet-Union-2.0.safetensors` (~6.25 GB, fp32 weights).
