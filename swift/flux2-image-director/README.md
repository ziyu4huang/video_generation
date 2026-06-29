# flux2-image-director

Swift CLI for Flux2 Klein 9B image generation on Apple Silicon (MLX). Image
director for multi-reference composition, style transfer, and face/scene editing.

## Build

```bash
# ALWAYS build release to RUN (debug builds hit a metallib crash at runtime).
swift build -c release --package-path swift/flux2-image-director
# → .build/release/flux2
```

## `flux2 scene` — multi-reference composition (Phase 8 + v2)

Composes a scene from N reference identities. v2 adds **background-as-canvas**
and **multi-LoRA stacking**.

### Background-as-canvas (`--bg`) — Workstream 1

By default every `--ref` is an identity/scene reference that only *steers* the
environment. Pass `--bg <image>` to make one image the **actual denoise canvas**:
its VAE-encoded latent becomes the SDEdit init latent, so the background's
**layout/POV is inherited** while characters emerge on top via the prompt +
identity refs. The `--bg` image is excluded from the identity refs.

```bash
flux2 scene \
  --ref charA.png --ref charB.png \
  --bg classroom.png --bg-strength 0.55 \
  --prompt "兩個角色坐在教室裡考試，表情平靜" \
  --width 1024 --height 1024 --steps 6 --seed 42
```

`--bg-strength` (SDEdit denoise fraction): `0.3` = light refine, `0.5` = restyle
keeping the layout, `0.7` = loose redraw. Characters are placed by prompt +
identity conditioning; precise left/right placement still needs regional masks
(not yet implemented — sweep `--seed`).

### Multi-LoRA stacking (`--lora`) — Workstream 2

`--lora` is **repeatable**; multiple LoRAs are rank-stacked into one merged
adapter (`Flux2LoRALoader.merge`): `A_merged = hstack(sqrt(sᵢ)·Aᵢ)`,
`B_merged = vstack(sqrt(sᵢ)·Bᵢ)`, so a single runtime path applies the sum. A
single `--lora` is numerically identical to a direct load.

```bash
flux2 scene --ref ... --prompt "..." \
  --lora anime-girl-turned-into-real-person --lora highresolutionflux2-kelien-9b \
  --lora-scale 0.8 --lora-scale 1.0
```

`--lora-scale` is repeatable (one per `--lora`; trailing ones default to `1.0`).
LoRA names resolve to `models/lora/<name>/*.safetensors` (prefers `*.int8.*`).

### Self-gating

Every output is self-gated by the shared `ImageGate` (noise / blank / NaN check).
`--strict-gate` aborts (exit 1) on a FAIL.

## `flux2 expand` — outpaint / 擴圖 (Phase 8 v3)

Extends an image beyond its borders via **latent-mask re-injection** (Flux2 has
no Fill variant). The original is centered on a larger canvas (edge-replicated
fill); during denoising the kept region's latent is forced back to its
VAE-encoded value each step, so the **original survives bit-perfect** while the
padded margins generate from the prompt. A final pixel composite locks the kept
region exact. (Verified: interior max-abs-diff = 1 vs original.)

```bash
flux2 expand --input photo.png --expand all --pixels 160 --feather 16 \
  --prompt "continue the background scene naturally" --steps 6 --seed 42
```

`--expand`: `all` (every side), a comma list (`left,right,top,bottom`), or an
aspect ratio (`16:9`, `4:3`, `3:2` — expands the shorter axis). `--pixels` is
the per-side margin (ignored for aspect presets). Canvas is rounded to a 16-multiple.

## `flux2 swap` — object/face swap (无痕换脸)

Replaces an object in the source (SAM3-segmented) with a reference. Two paths:

- **`--inpaint` (seamless / 无痕, recommended)** — regenerates the masked region
  via Flux2KleinEdit masked denoise (latent re-injection): the source outside the
  mask is locked bit-perfect, the object region is regenerated from the prompt +
  reference identity, blended across a feathered seam. No paste seam. Verified:
  VLM sees no hard seam, background intact, reads as a natural single photo.
  ```bash
  flux2 swap --source a.png --reference b.png --prompt "person" --inpaint --feather 20 --steps 6
  ```
- **paste path (default)** — feathered composite of the reference into the mask
  bbox, with `--preserve-aspect-ratio` (no stretch) and `--mask-dilate` (expand
  the region). Add `--harmonize` for a light KleinEdit blend pass.

`--prompt` is the SAM3 text prompt for the object to replace (person, face, …).

## `flux2 upscale` — 4× super-resolution (4K修復, Phase D)

Native Swift/MLX port of **RealPLKSR** (the arch behind `4xNomosWebPhoto_RealPLKSR`).
Pure convolutional 4× upscaler — no diffusion model loaded, sub-second on a 256²
input. Verified bit-accurate against the torch/spandrel reference: **PSNR 37.7 dB,
cosine 0.99988** (fp32 numerical noise only).

```bash
flux2 upscale --input photo.png            # → 4× (e.g. 1024² → 4096²)
```

The model weights are **not committed** (gitignored, ~30 MB raw download). Set up:

```bash
# 1. download the .pth (GitHub release)
curl -L -o python/mlx-movie-director/models/upscale/4x-nomos-webphoto-realplksr/4xNomosWebPhoto_RealPLKSR.pth \
  https://github.com/Phhofm/models/releases/download/4xNomosWebPhoto_RealPLKSR/4xNomosWebPhoto_RealPLKSR.pth
# 2. convert to MLX safetensors (Swift can't read torch pickles)
python/venv/bin/python -c "import spandrel; from safetensors.torch import save_file; \
  m=spandrel.ModelLoader(device='cpu').load_from_file('python/mlx-movie-director/models/upscale/4x-nomos-webphoto-realplksr/4xNomosWebPhoto_RealPLKSR.pth').model; \
  save_file({k:v.contiguous() for k,v in m.state_dict().items()}, \
  'python/mlx-movie-director/models/upscale/4x-nomos-webphoto-realplksr/4xNomosWebPhoto_RealPLKSR.safetensors')"
```

The port (`swift/common-image-director/.../ESRGAN.swift`) runs the whole net in
channels-last (NHWC), permuting torch NCHW weights at load, with GroupNorm /
EA attention / PixelShuffle implemented via reshape+permute to match PyTorch's
exact layout. Tiled inference for very large inputs is a follow-up.

## The 12-LoRA "卡通转真人工厂" stack

The ComfyUI workflow stacks 12 Flux2 Klein 9B LoRAs. WS2's `Flux2LoRALoader.merge`
rank-stacks them into one adapter, so `flux2 scene`/`style` can apply the full
stack with one `--lora` per entry. Download via `run.py import-lora --arch
flux2-klein-9b` + `convert_lora_mlx.py`.

| # | workflow filename | scale | installed name | source | status |
|---|---|---|---|---|---|
| 1 | f2k_anything2real_a_patched | 0.5 | `anything2real-a` | civitai | ✅ |
| 2 | Flux2 Klein…AnythingtoRealCharacters | 0.8 | `anything2real-characters` | civitai | ✅ |
| 3 | Chest_9B | 1.0 | `chest-9b` | civitai | ✅ |
| 4 | skin tone | 1.0 | `skin-tone` | civitai | ✅ |
| 5 | Lips_9B | 1.0 | `lips-9b` | civitai | ✅ |
| 6 | Eye_9B | 0.5 | `eye-9b` | civitai | ✅ |
| 7 | details (Realistic Detail) | 0.8 | `details-9b` | civitai | ✅ |
| 8 | LongFace_9B | 0.5 | `longface-9b` | HF NO8D/FaceControl | ✅ |
| 9 | Colorful | 0.5 | `colorful` | civitai 2425555 v2779689 | ✅ |
| 10 | qualitya | 0.8 | `qualitya` | civitai 2425555 v2727111 | ✅ |
| 11 | DarkKlein9b_v2BFS_extracted_lora_r256 | 0.25 | `darkklein-v2bfs-r256` | civitai 964312 v2742432 | ✅ |
| 12 | Kook_Flux_klein_亚洲人像 | 0.8 | `nexblend-asian` | civitai 2535707 v2849806 | ✅ |

**12/12 downloaded** (2026-06-30). The full stack is now reproducible — apply it
all in one `flux2 scene`/`style` call:
```bash
flux2 scene --ref ... --prompt "..." \
  --lora anything2real-a --lora anything2real-characters --lora chest-9b \
  --lora skin-tone --lora lips-9b --lora eye-9b --lora details-9b \
  --lora longface-9b --lora colorful --lora qualitya \
  --lora darkklein-v2bfs-r256 --lora nexblend-asian \
  --lora-scale 0.5 --lora-scale 0.8 --lora-scale 1.0 --lora-scale 1.0 \
  --lora-scale 1.0 --lora-scale 0.5 --lora-scale 0.8 --lora-scale 0.5 \
  --lora-scale 0.5 --lora-scale 0.8 --lora-scale 0.25 --lora-scale 0.8
```
`Flux2LoRALoader.merge` rank-stacks all 12 into one adapter. Add a single one:
```bash
python/venv/bin/python python/mlx-movie-director/run.py import-lora \
  '<https://civitai.com/models/ID?modelVersionId=VID>&token=$CIVITAI_API_TOKEN' \
  --arch flux2-klein-9b --name <slug> --no-ai
python/venv/bin/python python/mlx-movie-director/scripts/convert_lora_mlx.py --name <slug>
```
Source notes (provenance): #8 from NO8D `FaceControl` repo (the face-slider
pack); #9/#10 are two files from the same K-Slider "imaging control" pack
(`Colorful.safetensors` v2779689, `quality.safetensors` v2727111); #11 is the
rank-256 BFS extract from the `redcraft-exported-loras` pack; #12 is NexBlend
Asian Semi-Realistic (the real-world model behind the workflow's "亚洲人像" node).

## Known limitations / open decisions

1. **12-LoRA stack complete** (2026-06-30) — all 12 of the workflow's
   `卡通转真人工厂` LoRAs are installed + int8-converted + externalized. See the
   table above for the full reproducible `flux2 scene` invocation.
2. **ESRGAN runs whole-image** (no tiling). Fine for typical inputs (e.g. 1024² →
   4096² verified), but very large inputs may OOM on the (1,H,W,64) intermediates
   across 28 blocks. Add tiled inference (overlap-and-blend) if 4K+ sources are
   common. *Decision pending.*
3. **WS3 (per-reference strength + timestep gating for `scene`)** — still deferred
   from the v2 plan; not needed for the current workflow.

## Reproduce the full workflow

```bash
bash scripts/multiref-scene.sh   # z-image refs → flux2 scene (--bg + LoRAs) → gallery
```
