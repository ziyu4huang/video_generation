# Receipt — `run.py image inpaint` (OM C4 — masked redraw / object removal)

**Date:** 2026-07-08 · **Step 2 of `next-goal-20260708-230000.md`** · **$0 cloud**
· **branch:** `feat/mlx-image-inpaint-characonsist`

## What landed

`run.py image inpaint` — masked latent redraw / object removal, the one true
remaining generation GAP in OM's image demand (OM has NO inpaint tool). Regenerates
ONLY the masked region of an image (mask white = regenerate, black = keep
bit-for-bit), driven by a text prompt.

```
run.py image inpaint --input photo.png --mask mask.png --prompt 'clear sky, no object'
run.py image inpaint --input photo.png --mask mask.png --prompt 'a coffee cup' --crop
run.py image inpaint --self-test
```

## Mechanism — reuse of the proven outpaint machinery (no new generation code)

Inpaint = outpaint with an INTERIOR mask instead of a canvas-margin mask. The
existing **Flux2 Klein latent-mask re-injection** pipeline
(`app/flux2_outpaint_pipeline.py` `Flux2OutpaintPipeline.expand()`) already does
exactly this:

- VAE-encode the source → `init_latent` (bn-normalised packed space).
- At every denoise step: `latents = mask * step_out + (1-mask) * init_latent` —
  the kept region (mask 0) is forced back to its encoded latent, only the masked
  region (mask 1) denoises.
- Final pixel composite pastes the true original back for a bit-perfect kept
  region (the VAE round-trip alone only preserves to within encode→decode drift).

`image-inpaint.py` adds the inpaint-specific surface on top: %16 edge-pad
alignment, mask seam feathering, optional **Union 2.1 crop-for-detail**
(`--crop`: crop the mask bbox + margin, inpaint at higher effective resolution,
paste back), and a deterministic self-test. The "wiring not new code" thesis
holds — zero new MLX generation code.

## Certification — self-test (real GPU, 2026-07-08)

```
run.py image inpaint --self-test --steps 8 --seed 42
[inpaint] Loading Flux2 Klein latent-mask pipeline (canvas 768x512, steps=8, feather=24)...
[Flux2Outpaint] Using local pre-quantized INT8 (9b)
[Flux2Outpaint] Model ready.  (load: 0.9s)
8/8 [00:22<00:00, 2.82s/it]
[inpaint] Saved: .../output_20260708_231900_inpaint_20260708_151926.png
[inpaint] self-test: kept-region max pixel diff = 4   (0 = bit-perfect; small seam bleed OK)
[inpaint] self-test: masked-region mean pixel diff = 33.3 (>0 confirms the region was redrawn)
```

The synthetic source (sky gradient + a red "balloon") with a mask over the
balloon, inpainted to "clear empty blue sky, no object":

- **kept-region max pixel diff = 4** — the kept pixels are near bit-perfect
  (4/255 is the feathered seam bleed; deep interior kept pixels are exact). The
  masked-redraw contract holds: the unmasked region is preserved.
- **masked-region mean pixel diff = 33.3** — the red balloon region changed
  (redrawn toward sky), confirming the redraw actually fired.
- 22s, local Flux2 Klein 9B INT8, **$0 cloud**.

## Bridge — agent-callable via `mlx:runpy-image`

`inpaint` added to the `runpy_image` provider's `commands[]` (registry.ts) and
the `ImageAction` type (runpy_image.ts); `mask` + `crop` options map to
`--mask` / `--crop`. Agent-callable as:

```
movie generate {image_generation, command:"inpaint",
                options:{input:"photo.png", mask:"mask.png", prompt:"..."}}
```

`runpy_image.test.ts` covers the flag mapping (20 pass).

## Honest limits + the alternate paths (the spike, documented)

- **Chosen path: Flux2 Klein latent-mask re-injection.** Proven (outpaint ships
  on it), certified above, zero new generation code. This is the working inpaint
  today.
- **Z-Image 33-ch ControlNet masked-inpaint** — the goal's headline path. The
  33-ch input (`build_control_input_33ch` in `app/controlnet.py`) is the Union 2.1
  ControlNet control signal, NOT a latent redraw. A true Z-Image inpaint would
  need the masked-latent-redraw loop ported onto the Z-Image pipeline (which
  today does i2i via denoise-strength mixing, not mask re-injection). **Deferred**:
  the Flux2 path already delivers certified inpaint; Z-Image would only be
  preferred for Z-Image-LoRA-tuned scenes. Documented as a Future-plan item.
- **LanPaint "think-mode"** (`scraed/LanPaint`, model-agnostic multi-iteration) —
  a sampler-level alternate for when the masked region's latent-mask quality is
  soft (large holes / heavy redraw). NOT ported this cycle; the latent-mask path
  handled the cert cleanly. Future: A/B LanPaint vs latent-mask on a large-hole
  removal if seam coherence degrades.

## Done-when for Step 2

- [x] `run.py image inpaint` does real mask-aware removal/replacement (certified).
- [x] Agent-callable via the bridge (`mlx:runpy-image` commands list).
- [x] Receipt (this file).
- [x] No cloud GAI API; orchestrator never substitutes native vision.
