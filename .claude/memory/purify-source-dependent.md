---
name: purify-source-dependent
description: "image purify (SeedVR2) is source-dependent — rescues soft/under-detailed images but degrades already-sharp ones; skin plastic artifact unfixable by purify or restore"
metadata:
  node_type: memory
  type: feedback
---

`image purify` (SeedVR2 backend, `--purify-mode purify` = softness 0.3, `--resolution same`) is **source-dependent** — NOT a monotonic improve/degrade. Tested 2026-06-26 on moody-desire-mix (flux2-klein) best-of-4 seeds at 832×1216:

- **Soft / under-detailed input** (s45, baseline overall 6 / detail 5 / artifacts 5) → purify IMPROVED: overall 6→8, detail 5→8, artifacts 5→9. SeedVR2's color-correction + light redraw is ADDITIVE on a soft image (sharpens sweater weave + hair).
- **Already-sharp input** (s43, baseline overall 9 / detail 8 / artifacts 10) → purify DEGRADED: overall 9→7, detail 8→6, artifacts 10→5. The same op is SUBTRACTIVE on a crisp image (smears the detail that made it good). s43 was the best-of-4 winner because its seed luck gave good skin/texture; redraw threw that away.
- **Skin plastic artifact: unfixable by either op.** s45's complaint only got milder ("塑膠感" → "些微塑膠感"); no pores regrown. `image restore` (flux2-klein i2i, denoise 0.35) also did NOT rescue skin (s45 stayed overall 6 / artifacts 5). The MLX platform skin artifact has no generation-side lever.

**Why**: redraw re-runs the latent through the VAE, which re-smooths skin regardless of direction. On a soft image the sharpening/detail gain outweighs the re-smoothing; on a sharp image there is nothing to gain and everything to lose.

**How to apply**:
- Soft / under-detailed image → purify IS worth running (sharpen + add detail; net positive). This is purify's correct use case.
- Already-sharp / high-quality image → do NOT purify (only loses the detail that makes it good; s43 9→7 is the cautionary tale).
- To fix skin plastic → do NOT bother with purify OR restore; this pipeline's skin ceiling is the platform artifact. Resolution is not a fix either.
- ⚠️ VLM caveat: Gemma over-praised the s45-purify result (strengths said "寫實的皮膚紋理" while issues said "塑膠感" in the SAME score — self-contradiction). Treat skin-dimension jumps from Gemma as unreliable; visually inspect or use a harsh critic. Real-world s45 gain was ~6→7, not the headline 6→8.

### Related
- [[seedvr2-offload-device-mps]]
