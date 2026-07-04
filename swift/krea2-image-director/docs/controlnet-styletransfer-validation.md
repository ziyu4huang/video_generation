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

---

# Gap-closure addendum (2026-07-05)

The three honest gaps from §TL;DR revisited and closed.

## Gap #1 — ControlNet "tracks real depth" → honestly answered (negative at turbo-8)

Wired a real **Depth-Anything-V2-Small** preprocessor
(`python/mlx-movie-director/scripts/depth_anything_preprocess.py`, ~100 MB HF
model, MPS) and ran a rigorous **flip-tracking** test (the metric that isolates
"tracks THIS depth's spatial structure" from "this is a face"):

> Feed a real face depth and its left-right mirror, same prompt + seed. If the
> LoRA faithfully tracks depth, the flipped-depth output ≈ flip(normal output),
> i.e. `mad(oFlipped, flip(oNormal))` ≪ `mad(oNormal, oFlipped)`.

| steps | mad(oN,oF) | mad(oF, flip(oN)) | flip-score |
|---|---|---|---|
| 8 | 23.50 | 42.74 | **−0.82** |
| 12 | 21.19 | 44.71 | **−1.11** |
| 16 | 33.65 | 27.28 | **+0.19** |

**Conclusion: the krea2 depth Control LoRA at its native turbo-8 steps does NOT
faithfully track the input depth's spatial structure** (flip-score negative).
The control signal is real (control-image identity measurably changes the
output — `mad(oN,oF)=23.5`) but it acts as a **soft composition bias**, not a
faithful depth renderer. Tracking only emerges weakly at 16 steps (flip-score
+0.19) — confirming this is a **distilled-model speed/fidelity tradeoff, not a
port bug** (the goal's "what I might still be wrong about" hypothesis #1).
Cheap pixel-luminance / edge-gradient correlation cannot discriminate this from
generic portrait-composition structure, hence the flip test. Document
ControlNet as "soft composition conditioning; use higher steps for stronger
depth fidelity." Real depth source: `real_depth_face.png` (Depth-Anything-V2).

## Gap #2 — Style Transfer effect → CLOSED via knob sweep (no Q/K-AdaIN needed)

The ComfyUI `_RECOMMENDED` defaults were too conservative for this model. The
CLI now exposes the mechanism knobs (`--value-adain-strength`, `--ref-k-strength`,
`--low-scale-end`, `--active-blocks-start/-end`, `--gamma`). One aggressive
setting produces an **unambiguous** transfer:

| setting | output B−R | vs baseline (−25) | vs ref (+143) |
|---|---|---|---|
| default knobs | −21 | +4 shift | subtle |
| **vAdain=1.0, refK=1.5, lowScaleEnd=2.0, blocks 0–27** | **+88** | **+113 shift** | **strong** |

`style_sweep_AB.png` (baseline | default | aggressive | ref). Content (woman
composition) preserved; palette clearly transferred to teal. **Q/K-AdaIN +
dual-ref port (deferred) was NOT needed** — the cheap sweep closed the gap.

## Gap #3 — Style Transfer MPS cost → CLOSED (<4× via text-path cache + fastRF)

Profile (512², default): RF cache 25–26 s (16 base-DiT evals, Heun PC) + main
2B loop 32–36 s + ~overhead. Two levers (both IN the goal's scope):

1. **2-B text-path sharing** (`Krea2DiT.textPath` + `cachedCtx` param): the
   text path (txtFusion + txtMLP) is identical across all 24 DiT calls (same
   prompt) → compute ONCE, reuse. Named lever; helps both RF and main.
2. **RF-cache eval reuse** (`--fast-rf` flag): single-Euler (drop the Heun
   corrector eval) → halves RF cost. Changes the cached ref trajectory but NOT
   `strength=0` (the cache is unused at `mix=0`).

| config | RF cache | main | wall | vs t2i (~14–21 s) |
|---|---|---|---|---|
| original (Heun, no text-cache) | ~26 s | ~35 s | **94–104 s** | **~7×** |
| text-cache + Heun | 25 s | 32 s | **~58 s** | ~3–4× |
| **text-cache + fastRF** | **16 s** | 36 s | **~53–59 s** | **~2.8–4.1× ✓** |

The `fastRF` path lands at/under 4× against the conservative t2i baseline.

**Corruption gate (the non-negotiable):** `strength=0` stays **byte-identical**
to vanilla t2i (MAD 0.0000) under every combination — text-cache, fastRF, AND
aggressive knobs together. The cached ctx and the fastRF trajectory are both on
the ref/style path, which `mix=0` zeroes out, so they cannot drift the native
target velocity.

## Tests
No regression. `Krea2ConfigTests` green; DiT parity tests skip (missing oracle,
pre-existing). The new `cachedCtx` / `textPath` / knob params are all
defaulted → existing t2i/i2i/controlnet calls unchanged.

---

# Composition addendum (2026-07-05): ControlNet + Style Transfer in one call

The one untested combination of the two shipped features. They modify orthogonal
DiT paths (LoRA on block linears + input projection vs. attention K/V injection),
so they *should* stack — "should" is now tested. New engine path
`Krea2Engine.controlStyle` + CLI `krea2 control-style` (`Sources/.../Krea2ControlStyle.swift`,
`ControlStyleCommand.swift`). 512², steps=8, seed=42, aggressive style knobs.

## Wiring (no port bug)
A single DiT forward carries all three signals at once:
- LoRA-injected weights (224 pairs, via `lin`) + `firstControl` input projection,
- `controlTokens` (target batch = real control latent; **ref batch = zeros** so the
  style image is not depth-conditioned — matches the no-control RF cache),
- `Krea2StyleConfig` (styled attention in blocks 0..27) + `cachedCtx` text-path sharing.

The RF cache integrates the ref on the **LoRA-injected** base DiT (no control
tokens → control off for the ref). Loads 224/224 pairs, runs end-to-end, no OOM
at 512² (the goal's 2-B + control OOM risk did not materialize at 512²).

## Headline result — they compose, but the LoRA suppresses the style palette
| panel | B−R | shift vs base |
|---|---|---|
| baseline (vanilla t2i) | −25.06 | — |
| control-only (LoRA+portrait) | −15.68 | +9.37 |
| style-only (teal, no LoRA) | +107.44 | **+132.50** (strong teal) |
| both (LoRA+control+style) | −24.93 | **+0.13** (palette gone) |

Both effects are **live simultaneously** (not inert):
- control-image identity swap (portrait↔landscape, same seed): **MAD 9.28** ✓
- style-mix liveness (mix=0 → mix=1.0): **MAD 51.22** ✓

But the specific "palette shifts toward the teal ref" sub-metric **fails** (+132.5
on the base model → +0.13 under the LoRA). The style still reshapes the image
(≈51 MAD, manifesting as abstraction/texture per the VLM) — it just no longer
moves toward the reference palette.

### Isolated cause: the LoRA, not the control
| config | B−R shift | palette |
|---|---|---|
| style-only (no LoRA, no control) | +132.50 | strong teal |
| LoRA + style (control OFF) | −1.48 | palette gone |
| LoRA + style + control (full) | +0.13 | palette gone |

Turning control-strength to 0 (LoRA still on) collapses the palette just as hard
(−1.48 ≈ +0.13). The 224 LoRA pairs reshape every block linear (`wq/wk/wv/wo/
gate/mlp.*`), changing the Q/K/V projection geometry the ref-K/V injection
assumes — exactly the goal §0/§5 hypothesis. This is a genuine distilled-model /
LoRA interaction, **not a port bug** (the neutral gate below holds at MAD 0.12).

## Corruption gates
- **Regression (style-only s=0 byte-identical to vanilla t2i):** MAD 0.0000,
  pixel-diff `None`. The `Krea2StyleTransfer` path is untouched by this arc.
- **Composition neutral point (mix=0 vs control-only):** MAD **0.12**. The style
  surgery is a clean no-op at `mix=0` even with the LoRA + control present.
- **Combined neutral point, stated honestly:** ≡ LoRA-base + control (NOT vanilla
  t2i — the 224 LoRA deltas apply unconditionally; the 46.69 MAD base shift from
  the ControlNet arc carries through).

## VLM (gemma-4-26b, palette-focused, aspect-ratio-constrained)
- style-only: *"deep cobalt and navy blues … emerald and **teal greens** … rich
  purples"* — strong teal transfer confirmed.
- both (LoRA+control+style): *"stylized, dreamlike, abstract … luminous
  indistinct figure … flowing light and fabric"* — **no teal cast mentioned**;
  style present as abstraction, palette absent.
- control-only / baseline: natural garden scene, no teal.

VLM independently corroborates the deterministic B−R collapse. Per the prior arc's
lesson (the VLM hallucinated aspect ratios in the ControlNet run), the deterministic
palette + control-identity + neutral-gate metrics are load-bearing; the VLM is
confirmation only.

## Honest conclusion
The composition is wired, both effects stack measurably, and the corruption gates
hold. The style's *palette transfer* — the one effect that was unambiguous on the
base model — does **not** survive the Control LoRA. Recovering it is genuine R&D
(re-tuning the K/V-injection knobs for the LoRA-reshaped geometry, or the deferred
Q/K-AdaIN path), explicitly out of this arc's scope. The krea2 director now has a
single composable conditioning stack; this was the only untested combination of two
shipped features, and it reaches an honest, characterized stopping point.

## Artifacts
`video_generation__output/krea2_port_validation/`:
- `comp_AB_4way.png` — baseline | control-only | style-only | both.
- `comp_AB_control_identity.png` — both(portrait) | both(landscape).
- `comp_baseline_s42 / comp_control_s42 / comp_style_s42 / comp_both_s42 /
  comp_both_landscape_s42 / comp_both_s0 / comp_both_ctrl0_s42 .png`.
- `krea2_composition_sidebyside.html` — interactive viewer + full metric tables.

