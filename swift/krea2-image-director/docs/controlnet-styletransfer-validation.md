# Krea2 ControlNet + Style Transfer — real-silicon validation report

> Follow-up to `controlnet-styletransfer-port.md`. Closes the "it compiles, but
> does it work?" gap with on-device evidence (Apple Silicon, 2026-07-04).
> All runs: 512×512, steps=8, seed=42, prompt *"a woman in a flowing dress
> standing in a garden, soft natural light"*.

## TL;DR

| Feature | Loads | Runs | Wiring proof | Effect | Cost (512²) |
|---|---|---|---|---|---|
| ControlNet (Control LoRA) | ✅ 224/224 pairs | ✅ | strength-sweep monotonic (7.82→17.98 MAD); control-image identity matters (portrait↔landscape = 23.61 MAD) | live + responding; precise depth-tracking needs a real depth preprocessor | ~15 s (≈ t2i) |
| Style Transfer | n/a (weightless) | ✅ | **strength=0 is BYTE-IDENTICAL to vanilla t2i** (MAD 0.00) — RF cache + 2B batch + mask = zero drift | visible-but-modest (V-AdaIN + K-scale restyles texture/local stats more than global color) | **~94–104 s (~7× t2i)** ⚠️ |

## ControlNet

### Loads
`depth-control-lora.safetensors` (862 MB, `Patil/Krea-2-depth-controlnet`)
downloaded to `mlx-models/transformer/krea2-depth-control-lora/` and symlinked
as `model.safetensors` (the loader's expected name).

```
[control-lora] loaded 224/224 LoRA pairs + control half (rank 64, first from "first.weight")
```

Real checkpoint key/shape conventions (verified against the safetensors header):
- keys: `blocks.{i}.{target}.{A,B}` (NO `.weight` suffix) — matched by the
  loader's `.A/.B` suffix branch.
- `first.weight` = (6144, 128); control half = `[:, 64:128]` → (6144, 64).
- A = (rank=64, in), B = (out, rank); `normalizePair` transposes A→(in,rank)
  and keeps B=(out,rank). For `wk/wv` (out=1536) and `mlp.gate/up` (out=16384)
  the B axis order is still (out, rank) — confirmed.

### Signal-live proof (deterministic, fixed portrait control)
Strength sweep, same seed:

| strength | output MAD vs baseline |
|---|---|
| 0 → 0.5 | 7.82 |
| 0.5 → 1.0 | 17.98 |
| 0 → 1.0 (total control signal) | 19.83 |
| LoRA-only (s=0) vs vanilla t2i | 46.69 |

The control signal is monotonic and clearly above noise. Note the 224 LoRA pairs
substantially reshape the base model on their own (46.69 MAD at strength=0) — the
control-half input projection adds a further 19.83 MAD on top.

### Control-image identity matters
Same prompt, same seed, strength=1.0, swapping only the control image:

| pair | MAD |
|---|---|
| portrait-control vs landscape-control | 23.61 |

The specific control image's structure is measurably injected.

### Honest caveat — "tracks depth structure" is the unproven part
Pixel-luminance and Sobel-edge correlation between the output and the depth map
are weak/noisy (rank-corr |Δ| ≈ 0.05). That is expected: a turbo 8-step depth
ControlNet conditions global *structure*, not brightness, and today's control
images are **synthetic** (a Depth-Anything-V2 preprocessor is deferred). The
VLM reads composition tracking (portrait → tighter vertical bust, landscape →
wide horizontal) but was caught hallucinating aspect ratios, so the deterministic
strength-sweep + identity-swap are the load-bearing proof, not the VLM. A clean
"tracks real depth" test needs the real preprocessor (separate arc).

## Style Transfer

### Two real-silicon bugs surfaced + fixed (first run)
1. **Style image not resized to target** — `loadImage` returns native resolution;
   a 1024² reference into a 512² generation produced a ref latent with N ≠ target
   N → `[broadcast_shapes] (1,1,1536,64) vs (1,48,4608,64)`. Fix: added
   `loadImageResized(url, W, H)` (CGContext high-quality) in
   `Krea2StyleTransfer.swift`.
2. **`styledAttention` mask branch built a 5-D mask** — `mask[0..<tb]` is
   `(1,1,L,L)`; `.expandedDimensions(axis: 2)` yields 5-D, which mis-broadcasts.
   Fix: extract per-batch key-validity `mask[b, 0, 0, 0...]` → `(tb,1,1,L)` so it
   broadcasts over heads + query rows; appended ref K/V columns get an all-ones
   mask. (`Krea2DiT.swift`.)

### No-silent-corruption proof (the ablation that matters)
At `--strength 0` (`mix = 0`), the styled target attention reduces to native and
the RF cache is built but the target velocity path is untouched. Result:

```
diff(style_s0, baseline_t2i) = 0.00   # byte-identical
```

This is stronger than any VLM read: the Heun PC cache, the 2B-batch
concatenation, and the mask fix introduce **zero drift** at strength=0 — no
sign/direction error in the integrator or the attention surgery.

### Style signal is live + monotonic
| strength step | MAD |
|---|---|
| 0 → 0.5 | 35.43 |
| 0.5 → 1.0 | 27.72 |
| 0 → 1.0 | 39.43 |

### Effect is visible-but-modest (the design doc's stated risk)
With a strongly teal reference (B−R = +143), the output's B−R shifts only ~+4.5
toward the reference; VLM (neutral, aspect-ratio-constrained prompt) confirms a
teal cast + subtle brushstroke texture + content preserved. The minimal viable
port (V-AdaIN + K-scale only; Q/K AdaIN + dual-ref deferred) restyles
**texture / local value statistics** more than global color. Pixel MAD is large
(39) but mostly structural. A stronger recolor needs the deferred Q/K-AdaIN path.

### MPS cost ⚠️
512²: ~94–104 s vs ~14 s for vanilla t2i → **~7× slower** (above the 3× flag).
Cause: the RF cache evaluates the base DiT velocity twice per cached sigma (Heun
predictor-corrector) plus the main loop runs a 2-B batch each step. Performance
follow-up: share the text-fusion / text-MLP compute across the 2-B batch (the
two batches share the same prompt) and/or cache the ref batch's text path.

## Tests
No regression. `Krea2ConfigTests` green; DiT parity tests skip (missing oracle
file, pre-existing); `testTextFusionTransformer` hits the known test-bundle
metallib-load limit (release binary unaffected — not a logic bug).

## Artifacts
Outputs + composites under `video_generation__output/krea2_port_validation/`:
- `control_AB_3way.png` — baseline | portrait-control | landscape-control.
- `style_AB_3way.png` — baseline | style-transfer (teal ref) | teal reference.
- `krea2_validation_sidebyside.html` — interactive side-by-side viewer.
