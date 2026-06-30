# flux2-image-director

Swift CLI for **Flux2 Klein 9B** image generation on Apple Silicon (MLX) — a
multi-reference image director for scene composition, style transfer,
identity-preserving edit, outpaint, swap, and super-resolution.

> **Architecture & key techs:** see [`PRD.md`](PRD.md) (feature/architecture
> reference, every tech linked to source). Deep multi-ref internals:
> [`docs/multi-reference-architecture.md`](docs/multi-reference-architecture.md).
> This README is **CLI usage**.

## Build

```bash
# ALWAYS build release to RUN (debug builds hit a metallib crash at runtime).
swift build -c release --package-path swift/flux2-image-director
# → .build/release/flux2
```

## `flux2 scene` — multi-reference composition

Composes a scene from N reference identities, with background-as-canvas,
per-reference strength/gating, multi-LoRA stacking, and optional regional /
hand-repair post-passes. (Architecture: [`PRD.md` §3.1](PRD.md#31-multi-reference-conditioning-scene--style--swap).)

```bash
flux2 scene \
  --ref charA.png --ref charB.png \
  --bg classroom.png --bg-strength 0.55 \
  --prompt "兩個角色坐在教室裡考試，表情平靜" \
  --width 1024 --height 1024 --steps 6 --seed 42
```

### Options

- **`--bg <img>`** — background-as-canvas (SDEdit init latent; inherits the bg's
  layout/POV). `--bg-strength` 0.3=light refine · 0.5=restyle keeping layout ·
  0.7=loose redraw. Excluded from identity refs.
- **`--ref-strength`** (repeatable, one per `--ref`) — weight one identity over
  another. **`--ref-gate-steps`** — inject refs only the first fraction of steps
  (1.0 = all steps, default).
- **`--regional`** — post-pass: refine each ref into a vertical strip (left→right)
  via masked inpaint. `--regional-strength` 0.45 (SDEdit, default) nudges identity
  without re-rolling hands; 1.0 = full regen.
- **`--hand-repair`** — SAM3-segment "hands" then re-denoise that region
  (best-effort fix for fused/extra fingers). `--hand-repair-strength` 0.8 default.
- **`--lora <name>`** (repeatable) + **`--lora-scale`** (repeatable) — rank-stack
  multiple LoRAs into one adapter. See [§ The 12-LoRA stack](#the-12-lora-stack).
- **`--strict-gate`** — abort (exit 1) if the output fails the ImageGate self-check.

### Placement: use seed-select, not region-binding

Refs are **global** tokens (no identity→region binding), so placement is
prompt-driven & reliable-but-probabilistic. The engineering-efficient fix is
**seed selection**:

```bash
bash scripts/multi-seed-autoselect.sh [N]    # N seeds → local-LLM verify → keep best
```

`--region-attention` (OOD attention mask) and `--ref-region-mask` (in-distribution
latent mask) are **A/B-tested inert** on the distilled Klein (conflict 3/3 prompt
wins) — kept for reproducibility only; do **not** rely on them for placement.
Full analysis: [`docs/multi-reference-architecture.md`](docs/multi-reference-architecture.md) §6.

**Verified (2026-07-01):** a 2-girl classroom scene with distinct looks + different
poses + different activities (left: sitting + writing math; right: standing +
reading) landed correctly on **3/3 seeds** via prompt alone — reproduce with
[`scripts/scene-classroom-demo.sh`](scripts/scene-classroom-demo.sh), verify with
[`scripts/scene-verify.ts`](scripts/scene-verify.ts).

## `flux2 expand` — outpaint / 擴圖

Extends an image beyond its borders via latent-mask re-injection (the kept region
survives bit-perfect; padded margins generate from the prompt).
(Architecture: [`PRD.md` §3.3](PRD.md#33-latent-mask-re-injection-outpaint--inpaint--regional--swap-seamless).)

```bash
flux2 expand --input photo.png --expand all --pixels 160 --feather 16 \
  --prompt "continue the background scene naturally" --steps 6 --seed 42
```

`--expand`: `all` · comma list (`left,right,top,bottom`) · aspect ratio (`16:9`,
`4:3`, `3:2`). `--pixels` = per-side margin (ignored for aspect presets).

## `flux2 swap` — object/face swap (无痕换脸)

Replaces an object (SAM3-segmented) with a reference. Two paths:
- **`--inpaint`** (seamless / 无痕, recommended) — latent-mask inpaint: source
  outside mask locked bit-perfect, object regenerated from prompt + reference,
  blended across a feathered seam.
  ```bash
  flux2 swap --source a.png --reference b.png --prompt "person" --inpaint --feather 20 --steps 6
  ```
- **paste** (default) — feathered composite into the mask bbox
  (`--preserve-aspect-ratio`, `--mask-dilate`, `--harmonize`).

`--prompt` is the SAM3 text prompt for the object to replace.

## `flux2 upscale` — 4× super-resolution (4K修復)

Native MLX port of RealPLKSR — pure convolutional (no diffusion), sub-second on
256². Bit-accurate vs torch (PSNR 37.7 dB). Auto overlap-tile inference for large
inputs (verified PSNR 41.4 dB tiled vs whole; 2048²→8192² without OOM).
(Architecture: [`PRD.md` §3.6](PRD.md#36-realplksr-4-super-resolution-upscale).)

```bash
flux2 upscale --input photo.png                 # → 4× (e.g. 1024² → 4096²)
flux2 upscale --input photo.png --no-tile       # force whole-image
```

> The weights are gitignored (~30 MB). One-time setup — download the `.pth` then
> convert to MLX safetensors (Swift can't read torch pickles):
> ```bash
> curl -L -o /tmp/r.pth https://github.com/Phhofm/models/releases/download/4xNomosWebPhoto_RealPLKSR/4xNomosWebPhoto_RealPLKSR.pth
> python/venv/bin/python -c "import spandrel; from safetensors.torch import save_file; \
>   m=spandrel.ModelLoader(device='cpu').load_from_file('/tmp/r.pth').model; \
>   save_file({k:v.contiguous() for k,v in m.state_dict().items()}, \
>   'python/mlx-movie-director/models/upscale/4x-nomos-webphoto-realplksr/4xNomosWebPhoto_RealPLKSR.safetensors')"
> ```
> Architecture/port details: [`PRD.md` §3.6](PRD.md#36-realplksr-4-super-resolution-upscale).

## The 12-LoRA stack

The source ComfyUI workflow stacks 12 Flux2 Klein LoRAs; `Flux2LoRALoader.merge`
rank-stacks them into one adapter. Full table (scale / source / key-format) is in
[`PRD.md` §4](PRD.md#4-the-12-lora-卡通转真人工场-stack); apply the whole stack in one call:

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

Add a single LoRA:
```bash
python/venv/bin/python python/mlx-movie-director/run.py import-lora \
  '<https://civitai.com/models/ID?modelVersionId=VID>&token=$CIVITAI_API_TOKEN' \
  --arch flux2-klein-9b --name <slug> --no-ai
python/venv/bin/python python/mlx-movie-director/scripts/convert_lora_mx.py --name <slug>
```

All three Flux2 LoRA key conventions (BFL / WebUI-ComfyUI / diffusers) load; the
CLI logs each LoRA's `adapters=N` and warns on `0 adapters` (silent no-op).

## Limitations & findings

Architectural limitations (hands ceiling, skin plastickness, no region binding)
and the empirical A/B findings (regional net-negative, region-binding inert, demo
3/3) are in [`PRD.md` §5–6](PRD.md#5-empirical-findings-local-llm-verified-2026-0607).

## Reproduce the full workflow

```bash
bash scripts/flux2-full-lora-stack.sh            # z-image refs → full 12-LoRA scene → gallery
bash scripts/flux2-full-lora-stack.sh --reuse-refs
bash scripts/multiref-scene.sh                   # lighter 2-LoRA variant
bash scripts/scene-classroom-demo.sh 5 1         # complex multi-pose demo + verify
```
