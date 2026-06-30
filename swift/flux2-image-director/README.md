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
identity conditioning; precise left/right placement uses `--regional` (below).

### Per-reference strength + timestep gating (WS3)

```bash
flux2 scene --ref A.png --ref B.png \
  --ref-strength 1.0 --ref-strength 0.4 \   # weight ref B lower
  --ref-gate-steps 0.5 \                    # inject refs only the first half of steps
  --prompt "..."
```
`--ref-strength` (repeatable, one per `--ref`) scales each reference's
conditioning tokens — weight one identity over another. `--ref-gate-steps`
injects the refs only in the early fraction of steps (after the gate the model
finishes the scene without their pull); `1.0` = all steps (default).

### Regional placement (`--regional`)

Flux2KleinEdit conditions on **global** ref tokens — there is no
identity→spatial-region binding, so left/right placement is otherwise
prompt-driven (non-deterministic). `--regional` adds a post-pass: after the base
scene, each distinct ref is identity-refined into its own **vertical strip**
(left→right, `ref[0]`→leftmost) via masked inpaint, locking the rest.

```bash
flux2 scene --ref A.png --ref B.png --regional --regional-feather 24 --prompt "..."
```
This is a **best-effort** approximation, not perfect identity locking: the
strips are half-plane regions, so the base scene's figures and the strip
refinements can overlap (e.g. produce an extra figure). It reliably assigns each
ref to a side, but is approximate — true region-bound identity needs an
architecturally different conditioning path (not in Flux2KleinEdit).

**Tested empirically (2026-06-30, local-LLM verified):** for a clear 2-person
prompt with distinct visual cues (extreme hair colour), `--regional` at the old
default (full regen, strength 1.0) was **net negative** — reproduce with
`bash scripts/regional-placement-test.sh` + `scripts/fullbody-stress-test.sh`,
verify with `scripts/verify-placement.py` / `scripts/harsh-hand-check.py`
(qwen3-vl-4b + gemma-4-26b via `run.py caption`):
- Baseline (no `--regional`) got left/right correct on **all 3 seeds** (42/77/123,
  prompt_adherence 9–10) — the "placement is non-deterministic" caveat is overly
  pessimistic when the prompt + refs are visually unambiguous.
- `--regional` (strength 1.0) was 2.5× slower (259 s vs 100 s) and scored *worse*:
  gemma flagged "ghosting/duplication of the second subject" + "malformed/fused
  fingers" on the crossed-hands region (artifacts 3 vs baseline-best 9). Cause:
  the strip inpaint **fully regenerated** the masked region from pure noise,
  re-rolling hands.

**Fix (2026-06-30): `--regional-strength` (SDEdit partial denoise, default 0.45).**
The strip is now refined via PARTIAL denoise — it starts from a lightly-noised
copy of the existing scene (not pure noise) and runs only the last fraction of
steps, so identity is nudged into the strip **without re-rolling hands**. This is
the SDEdit path (`Flux2EditPipeline.inpaint(denoiseStrength:)`), mirroring the
background-as-canvas path. `--regional-strength 1.0` restores the old full-regen
behaviour (re-rolls hands); lower = gentler.

### Hand repair (`--hand-repair`)

The hardest generation artifact is **hands** (fused/extra fingers) — a known
platform ceiling. `--hand-repair` is a genuine scene-side mitigation: after the
scene, SAM3 text-segments the `"hands"` regions, and each is re-denoised
(inpaint) from the prompt so deformed hands get a regeneration retry.

```bash
flux2 scene --ref A.png --ref B.png --hand-repair --hand-repair-strength 0.8 --prompt "..."
```

Verified (local LLM): on a full-body 2-person scene where gemma flagged
"softness/lack of detail in hands", `--hand-repair` removed the hand-specific
complaint (issues fell back to the baseline plasticky-skin platform artifact
only). Best-effort — regeneration can occasionally introduce new defects, and
SAM3 saves only the single highest-confidence hand mask per call, so it repairs
the most prominent hand region. `--hand-repair-strength` 0.6 = conservative,
0.8 = stronger (default).

**Recommended workflow (best of both):** for normal multi-person scenes, run a
**seed sweep + auto-select** instead of `--regional` —
`bash scripts/multi-seed-autoselect.sh [N]` runs N seeds, verifies each with the
local LLM (placement correctness + hand quality), and keeps the verified-correct
best (`autoselect-report.html`). This exploits that prompt placement is
reliable-but-probabilistic (no architectural fight), which is more
engineering-efficient than `--regional` or porting IP-Adapter Regional. The real
quality ceiling remains **hands** (artifacts 3–5 across the board), a platform
limitation not fixable from `scene`.

### Region-bound attention (`--region-attention`) — experimental, tested inert

`--region-attention` adds a block attention mask during the single denoise pass
so a noise token attends a ref token only when their region matches (binding
identity→region, in-denoise — vs `--regional` which is a post-pass). Layout =
vertical strips by default, or `--ref-mask <img>` per `--ref`.

**⚠️ A/B-tested 2026-06-30 and it does NOT bind placement on this distilled
Klein model** — in a mask-vs-prompt conflict the prompt won on 3/3 seeds (the
model ignores the masked-ref path it never trained on; OOD). Quality-neutral but
~2× slower. Kept for reproducibility (`scripts/region-attention-test.sh`);
**do not rely on it for placement** — use the seed-sweep workflow above. Full
analysis: `docs/multi-reference-architecture.md` §6.

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
exact layout.

### Tiled inference (large inputs)

For inputs larger than one tile, `flux2 upscale` auto-switches to **overlap-tile
inference** (256px LR tiles, 32px overlap, linear feather-blend) so 4K+ sources
don't OOM the (1,H,W,64)×28-block intermediates. Verified: tiled vs whole-image
PSNR **41.4 dB** (mean-abs 1.1/255 — per-tile GroupNorm stat error only); 2048²
→ 8192² upscales in ~11 s without OOM.

```bash
flux2 upscale --input photo.png --tile-size 256 --tile-overlap 32   # auto-on > 256
flux2 upscale --input photo.png --no-tile                            # force whole-image
```

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

### LoRA key-format handling (all three Flux2 LoRA conventions)

Authors ship Flux2 Klein LoRAs in three key-naming conventions; all three now
load (verified: each logs `adapters=N>0`):

| format | key example | where handled |
|---|---|---|
| **BFL native** | `diffusion_model.double_blocks.0.img_attn.qkv.lora_A.weight` | loader (always) |
| **WebUI/ComfyUI** | `lora_unet_double_blocks_0_img_attn_proj.lora_down.weight` | `convert_lora_mlx.py` remaps → BFL at int8 time |
| **diffusers** | `transformer.single_transformer_blocks.0.attn.to_qkv_mlp_proj.lora_A.weight` | loader (runtime path used directly, no split) |

The CLI prints each LoRA's resolved adapter count (`adapters=N`) and warns on
`0 adapters` (a silent no-op = key-format mismatch). WebUI→BFL remapping lives
in `convert_lora_mlx.py` (`remap_lora_keys`); the diffusers path is recognized
directly by `Flux2LoRALoader.load`. Of the 12, 9 are BFL, 2 WebUI (nexblend,
darkklein), 1 diffusers (anything2real-a — a partial 88-adapter LoRA).

## Known limitations / open decisions

1. **12-LoRA stack complete** (2026-06-30) — all 12 of the workflow's
   `卡通转真人工厂` LoRAs are installed + int8-converted + externalized. See the
   table above for the full reproducible `flux2 scene` invocation.
2. **ESRGAN tiled inference** — DONE (2026-06-30). `flux2 upscale` auto-tiles
   large inputs (256px tiles, 32px overlap, feather-blend); verified PSNR 41.4 dB
   vs whole-image, 2048²→8192² without OOM.
3. **WS3 (per-reference strength + timestep gating)** — DONE (2026-06-30).
   `--ref-strength` (per-ref token weight) + `--ref-gate-steps` (early-step
   injection fraction) on `flux2 scene`.
4. **Regional placement** — DONE as best-effort (2026-06-30). `--regional`
   refines each ref into a vertical strip via masked inpaint. Approximate (no
   clean identity→region binding in Flux2KleinEdit); see the section above.

## Reproduce the full workflow

```bash
# z-image refs → flux2 scene with the FULL 12-LoRA 卡通转真人工场 stack → gallery
bash scripts/flux2-full-lora-stack.sh            # regenerates refs via z-image
bash scripts/flux2-full-lora-stack.sh --reuse-refs  # reuse any existing ref*.png
bash scripts/multiref-scene.sh                   # lighter: 2-LoRA variant
```
The full-stack run logs each LoRA's adapter count (proves the key-format remap
held) and self-gates every image into `full-stack-gallery.html`.
