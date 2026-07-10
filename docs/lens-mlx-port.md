# Microsoft Lens — MLX Port Notes

Microsoft Lens 3.8B (dual-stream MMDiT) ported to pure MLX for text-to-image on
Apple Silicon. Lens is the `--pipeline lens` option of `run.py image t2i`
(alongside `zimage` / `flux2-klein` / `auto`).

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --pipeline lens --prompt "..."            # defaults: 1024², 20 steps, cfg 4.0
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --pipeline lens --self-test               # corgi, ~7.8s
```

Generation cost: ~7.4 s for 20 steps at 512² (INT4 UNet 2.6 GB + INT4 TE + BF16
Flux2 VAE), ~12 s incl. load. Lens is a high-resolution model (gallery is all
≥1440²); 512² is OOD, quality rises further at 1024² (+43% high-freq) and 50
steps (the official default).

---

## Architecture facts (verified against the official diffusers reference)

- **Latent format** — Flux2 VAE → 32-ch `[B,32,H/8,W/8]`. Patchify 2×2 spatial →
  128-ch `[B,128,H/16,W/16]`. The model input **and** output are patchified.
- **Sampling** — `ModelSamplingFlux`, Euler in velocity/flow space,
  `timestep-embedding input = sigma·1000`. Dynamic `mu` via
  `compute_empirical_mu(seq_len, steps)` (NOT a fixed shift — the fixed 1.829
  value only applies to 1440²).
- **RoPE** — 3 axes (frame=8, h=28, w=28) = 64 = head_dim, **complex-
  multiplication form** (interleaved pairs `(x[2i], x[2i+1])`, NOT half-split).
  Text positions replicate across all 3 axes starting at `max(h//2, w//2)`;
  image positions are centered around 0.
- **Text encoder** — GPT-OSS-20B MoE, 4 selected layers (5/11/17/23) stacked →
  context dim 4·2880 = 11520; 97 prefix tokens trimmed. Outputs large-magnitude
  features (`std ≈ 234`) — **expected**, normalized by the UNet's `txt_norm`
  (RMSNorm). Don't reuse the TE elsewhere without an RMSNorm.
- **Modulation** — Flux-style adaLN-zero per block (`img_mod`/`txt_mod` produce
  `[shift,scale,gate]`×2 via `Sequential(SiLU, Linear)`).

---

## Porting gotchas (the bugs that broke denoising)

Found by diffing against `comfy/ldm/lens/model.py` + `comfy/ldm/flux/math.py`.

1. **RoPE convention** — a half-split rotation is wrong; must be interleaved
   complex multiplication (verbatim match to `comfy.ldm.flux.math.rope` /
   `_apply_rope1`, identical to the working mflux `EmbedND`).
2. **Patchify channel order** — the UNet is linear on the flat 128-vector, so it
   operates entirely in patchified `[B,128,h,w]` space. The reference returns the
   patchified output and lets the **caller** patchify/depatchify. Do the Euler
   step in patchified space (`latents = latents + v·dt`) and depatchify **once**,
   only for the final VAE decode.
3. **VAE batch-norm de-normalization** — Flux2 VAE BN de-norm (`packed×std+mean`
   in 128-ch space) must happen before unpatchify, or output is soft/color-graded.
4. **CFG velocity norm-rescale** — `pred = comb × cond_norm/comb_norm` (the
   combined velocity must be norm-rescaled against the conditional). Empty
   negative must be **zeros + all-False mask**, not an encoded empty string.
5. **`shift` is `mu`, not `exp(mu)`** — use the `flux_time_shift(mu, 1, t)` form
   with a dynamic `mu` (gotcha #1 in the architecture list). Official CFG = 4.0.

> Diagnostic red-herring: the UNet's `final_hidden` std reaches millions/billions
> on **random** (out-of-distribution) context features — a self-reinforcing
> feedback through the large modulation gates. With **real** TE features this
> does not occur; always use real features for behavioral diagnostics.

---

## Component map

| Component | File |
|-----------|------|
| MLX Text Encoder | `app/lens_text_encoder.py` |
| MLX UNet | `app/lens_model.py` |
| MLX Pipeline | `app/lens_pipeline.py` |
| run.py wiring | `app/commands/lens.py` (`run_lens`), dispatched from `app/commands/image-t2i.py` (`--pipeline lens`) |
| TE conversion (NVFP4 → MLX) | `scripts/convert_lens_te_mlx.py` |

The GUI does not yet have a Lens view — the CLI/schema surface is complete, so a
GUI view is a pure frontend addition when wanted.
