# CharaConsist feasibility spike (Step 3 — `next-goal-20260708-230000.md`)

**Date:** 2026-07-08 · **branch:** `feat/mlx-image-inpaint-characonsist` · **$0 cloud**

A research spike assessing whether CharaConsist (arXiv [2507.11533](https://arxiv.org/abs/2507.11533),
ICCV 2025; code [Murray-Wang/CharaConsist](https://github.com/Murray-Wang/CharaConsist)) — a
training-free, FLUX.1-DiT, fg+bg consistent-character method — can upgrade our
current **soft** character-lock (seed + Flux2KleinEdit reference conditioning)
into a **position-aware** lock on the local MLX path.

## What CharaConsist actually is (the mechanism)

CharaConsist is the **first training-free consistent T2I method built on a DiT
(FLUX.1-dev)**. Three components, all training-free:

1. **Point-tracking attention** (the core, position-aware identity). Establishes
   positional correspondences across images, then **re-encodes the RoPE
   positional embeddings** of the stored attention keys during inter-image
   information sharing. Because FLUX applies RoPE directly at each attention
   layer, keys can be stored without positional embedding and re-encoded later —
   so a critical feature tracked at position *p* in shot *A* is re-anchored to
   its tracked position in shot *B*. This is what lets the character keep
   identity/clothing detail under **large motion variation** (the failure mode
   of plain reference conditioning).
2. **Adaptive Token Merge.** Re-encoding positions can disrupt local token
   geometry / lose unmatched tokens; token merge adaptively recombines the
   attention output to repair that (`--use_interpolate`; higher CPU memory).
3. **Training-free mask extraction + decoupled fg/bg control.** The mask is
   derived from the attention weights of image tokens to **foreground vs
   background TEXT tokens** (the prompt is formatted "background description,
   then foreground description"). `share_bg` keeps the background fixed across
   shots; fg-only mode varies it.

## Our current lock (the baseline this would upgrade)

`src/character_lock.ts` + `run.py image storyboard`: recurring-character shots
lock the seed + use the hero as a Flux2KleinEdit **reference-conditioning** input
(latent concat — a GLOBAL token injection, `--ref` + `--ref-count`) at high
denoise. This is a **SOFT** lock (see `docs/character-consistency-recipe.md`):
it biases style/global identity but is not position-aware, so large motion
variation breaks clothing/identity detail.

## Port surface to MLX flux2-klein — precise assessment

| CharaConsist component | Portable to our MLX path? | Effort |
|---|---|---|
| **Point-tracking attention** (per-layer attention intercept + RoPE key re-encoding across shots + a point-matching step) | **Substantial port.** Requires intercepting attention at **every layer** of the vendored mflux Flux2 DiT transformer, storing keys position-less, and re-applying RoPE at tracked positions during inter-image sharing. Our reference conditioning does latent concat, NOT per-layer position re-encoding — this is precisely the gap. | Multi-session transformer-loop surgery on `app/transformer.py` / the mflux Flux2 attention path. |
| **Adaptive Token Merge** | **Substantial port.** Same per-attention-layer hook to recombine the output. | Couples to the attention intercept above. |
| **Mask extraction (attention-based, fg-vs-bg text tokens)** | **Portable.** Needs the per-layer attention map (same intercept as above) OR substitute our existing **SAM3** text-prompted segmentation (`app/sam3_predictor.py`) for the character mask. | Low if SAM3 stands in; medium if true attention-based mask is wanted. |
| **fg/bg decoupled control + prompt formatting** | **Portable now** (pure prompt/driver logic): format prompts "background, then foreground"; route `share_bg` to keep the background latent fixed (we already have masked-latent machinery from Step 2's inpaint to hold a region). | Low. |

## Feasibility verdict — honest negative on a full port this cycle

The **position-aware** value of CharaConsist (point-tracking attention) is real
and is exactly the upgrade over our soft ref-cond — but it lives **inside the
DiT attention loop**, coupled to the diffusers FLUX implementation. Porting it
to the vendored **mflux Flux2** transformer on MLX is a substantial,
multi-session engineering effort (per-layer attention intercept + RoPE
re-encoding + point matching + token merge), **not a spike-achievable port**.
The goal's gate explicitly allows "or an honest negative result" — this is it
for the full implementation (3b) and A/B certify (3c).

## What IS worth doing now (the portable pieces, queued)

1. **Prompt formatting + fg/bg decoupling** (cheap, do next): format storyboard
   prompts as "background description, then foreground description" and add a
   `--share-bg` mode that reuses Step 2's masked-latent-redraw to hold the
   background latent fixed across recurring-character shots. This is a real,
   cheap consistency upgrade in the CharaConsist spirit without the attention
   surgery.
2. **SAM3 as the mask source** for a mask-guided ref-cond variant (constrain the
   reference conditioning to the SAM3 character region). Stronger region
   focus than today's global ref-cond; still not position-aware.
3. **Full point-tracking-attention port** (deferred): the real CharaConsist.
   Tracked as a Future-plan research item — the leverage is high but the cost is
   a deep mflux transformer-loop fork (and a vendor-patch candidate, see
   `app/vendor_patches.py`, rather than a submodule edit).

## References

- Paper: <https://arxiv.org/abs/2507.11533> (HTML: <https://arxiv.org/html/2507.11533v1>)
- Code: <https://github.com/Murray-Wang/CharaConsist> (ICCV 2025; FLUX.1-dev; `point_and_mask/` has the standalone mask + point-matching code)
- Project: <https://murray-wang.github.io/CharaConsist/>
- Related local memory: `[[mlx-image-gen-om-gap-analysis]]` (Gap 2), the soft
  ref-cond recipe in `docs/character-consistency-recipe.md`.

## Done-when for Step 3

- [x] CharaConsist spike documented (mechanism + port surface + feasibility).
- [x] Honest verdict: full position-aware port is a substantial multi-session
      mflux transformer-loop effort (deferred); portable pieces (prompt
      formatting, fg/bg decoupling via Step-2 masked latent, SAM3 mask) queued.
- [x] No cloud GAI API.
