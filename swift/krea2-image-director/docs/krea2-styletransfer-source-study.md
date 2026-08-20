# ComfyUI-Krea2-StyleTransfer source study → Swift port gap analysis

> Study of `jieg9341-lab/ComfyUI-Krea2-StyleTransfer` (the ORIGINAL of the Swift
> port in `swift/krea2-image-director`) against the minimal viable Swift port.
> Goal: identify exactly what the Swift port skipped, prioritize re-ports, and
> scope flux2 / pi-ext enhancements. 2026-07-05.

Sources studied (cloned to `/tmp/krea2-study/`):
- `nodes.py` (2566 lines) — full Python mechanism (5 nodes).
- `workflows/Krea2 Style Transfer Workflow.json` (single-ref, 12 nodes).
- `workflows/Krea2 Two Style Transfer Workflow.json` (dual-ref, 15 nodes).
- `README.md` — node surface + recommended preset + the `low_scale_end`/
  `ref_k_strength` decoupling idea.

## Architecture (how it wires in ComfyUI)

`Krea2StyleTransfer` is a **model patcher** (MODEL in → MODEL out): it clones the
model, monkey-patches `blocks.N.attn.forward` + installs a `SAMPLER_SAMPLE` wrapper
to capture sigmas, and a `model_function_wrapper` that builds the RF cache on the
first step, concatenates `[target ; ref_noisy]` along batch, runs `apply_model`,
slices `[:target_b]`. KSampler then runs normally on the patched model. Neither
example workflow uses ControlNet. The Swift port's equivalent is its own Euler
denoise loop driving a `Krea2DiT` configured with `Krea2StyleConfig` — a correct
architectural translation (no Comfy in Swift).

## Node surface

| Node | Role | Swift? |
|---|---|---|
| `Krea2StyleReference` | preprocess ref image → ref latent (crop/contain/stretch fit) | ~ (stretch only) |
| `Krea2StyleTransfer` | single-ref patcher | ✓ (architecturally) |
| `Krea2TwoStyleReferences` | bundle 2 ref latents + weights → STYLE_REFS | ✗ |
| `Krea2TwoStyleTransfer` | dual-ref patcher (`multi_delta`) | ✗ |
| `Krea2SizePreset` | latent-size convenience | n/a |

## Single-ref recommended preset (the contract to match)

```
style_strength=1.0  value_adain_strength=0.65  ref_value_mix=1.0  ref_k_strength=1.06
rf_mode=flowturbo_pc  gamma=0.5  beta=2.5
high_scale_start=1.04  high_scale_end=0.0  low_scale_start=1.0  low_scale_end=1.10
adain_strength=0.85   blocks=7-27
```
**The Swift `Krea2StyleDefaults` has 11 of these 12. The one missing is
`adain_strength=0.85` (Q/K AdaIN).**

## Gap ranking (highest value first)

### Gap 1 — Q/K cross-batch AdaIN  ✗ skipped  ← THE big one
`_cross_batch_adain_qk` (nodes.py:348-371), applied to image tokens BEFORE the
method branch, gated by `adain_strength` (default 0.85, ON in recommended):

```
α = clamp(adain_strength, 0, 1)        # effective_adain scales by min(strength,1.25)
q_t = q[:target_b, img_s:img_e];  q_r = q[target_b:2*target_b, img_s:img_e]
q_out[:target_b, img_s:img_e] = q_t·(1-α) + AdaIN(q_t, q_r)·α
k_out[:target_b, img_s:img_e] = k_t·(1-α) + AdaIN(k_t, k_r)·α
# AdaIN per-head, over the image-token axis:  (x - mean_t)/std_t · std_r + mean_r
```

The reference's per-head mean/std over image tokens are blended onto the TARGET's
Q and K. The Swift port's V-AdaIN does this only for V; Q and K are untouched
(K only gets the per-frequency scale, not stat-transfer). **This is on by default
upstream, so the Swift port has silently been running a degraded preset.** It is
the most likely reason the composition arc (#249) found the style palette
collapses under the Control LoRA — the palette-relevant signal lives in the
Q/K geometry that V-only injection never touches.

### Gap 2 — Dual-ref `multi_delta`  ~ plain_average PORTED end-to-end (pipeline+CLI); rich fusion modes deferred (2026-07-05)
`Krea2TwoStyleTransfer` builds one RF cache per ref, concatenates
`[target ; ref1_noisy ; ref2_noisy]`, computes per-ref style deltas vs native,
fuses them. Fusion modes: `plain_average`, `step_cycle` (default), `block_cycle`,
`rms_balanced`, `consensus`. `step_cycle` uses `_stage_weights` (forward/reverse/
weighted/alternating schedules, Gaussian bumps, `late_release` fade) +
`primary_reference` order shift. Per-ref knobs: `ref_k_1/ref_k_2`, weights from
the bundle node `[0.5, 0.5]`. **Not a weighted average — order-sensitive.**

**Foundation ported (2026-07-05):** `Krea2StyleConfig` carries `refB` + `refWeights`;
`styledAttention` weighted-averages the refB rows (`plain_average`) for the K/V
injection while each ref row's own attention output is preserved; gate is now
`B == (1+refB)·targetB`. `refB=1`/weights `[1]` → single ref unchanged → single-ref
byte-identical (no regression). `DualRefTests` covers the pure weight-normalization.

**Pipeline + CLI ported (2026-07-05):** `Krea2Engine.dualStyleTransfer` builds one RF
cache per ref (shared integrator via a local closure — the single-ref path is
untouched) and runs a 3-B batch `[target; ref1_noisy; ref2_noisy]` with `refB=2`.
`krea2 dual-style-transfer --style-images A,B --weights 0.5,0.5` — verified
end-to-end on real silicon (2 RF caches, 3-B denoise, image produced). Gate
(strength=0 == vanilla t2i) holds by the same mix=0 routing + batch-invariance as
single-ref (krea2 vanilla is manual attention; at mix=0 the styled path reduces to
native manual == vanilla). **Still deferred:** `step_cycle`/`block_cycle`/
`rms_balanced`/`consensus` fusion, `primary_reference` order shift, per-ref
`ref_k_1/ref_k_2`.

### Gap 3 — RF integrator modes  ✓ PORTED (2026-07-05)
Swift now has all four upstream integrators via `RFMode` (exposed as
`--rf-mode flowturbo_pc|rf_gamma|rf_gamma_rk2|linear`):
- `flowturbo_pc` (default): Heun PC + γ-blend.
- `rf_gamma`: plain single-Euler + γ-blend (formalized from the legacy `fastRF`
  shortcut; `fastRF=true` is now a back-compat alias via `RFMode.resolve`).
- `rf_gamma_rk2`: explicit midpoint RK2 (k1 at lastSigma, k2 at the midpoint,
  full step on k2).
- `linear`: pure linear prior `(1-σ)·refClean + σ·eps`, no model call (fastest).
The cache loop dispatches on the mode in both Krea2StyleTransfer +
Krea2ControlStyle. Gate-safe: the RF cache only feeds the styled path's
ref_noisy, which `mix=0` discards at strength=0, so the integrator choice never
affects the corruption gate. `_flowturbo_pc_internal_sigmas` (midpoint grid
refinement) is still NOT ported — Swift iterates the raw sampler grid; low value.

### Gap 4 — `value_mode` variants  ✗ (only `target_adain_plus_ref` ported)
Upstream supports `raw_reference | target | ref_mean | target_adain |
target_adain_plus_ref`. Both patchers hardcode `target_adain_plus_ref`, so this
is low-value.

### Gap 5 — strength-rescaling of scale endpoints  ✓ PORTED (2026-07-05)
At patch-time upstream rescales (nodes.py:1987-1989):
```
effective_high = 1 + (high_scale_start-1)·min(strength,1.5)
effective_low  = 1 + (low_scale_end-1)·strength
effective_adain = clamp(adain_strength·min(strength,1.25), 0, 1)
```
Previously Swift passed the scale-endpoint knob values verbatim (adain was
already rescaled). Now `effHighStart`/`effLowEnd` are computed and fed to
`styleScaleVec` in both Krea2StyleTransfer.swift and Krea2ControlStyle.swift.
Identity at `strength=1.0`; dampens toward 1 at partial strength. The corruption
gate (strength=0 byte-identical) is preserved: at strength=0 the endpoints →1,
but `mix=0` discards the styled path (scaleVec only feeds refK on the styled
path), so vanilla output is unaffected.

### Gap 6 — `stat` method  ✗ (alternative path, not in recommended)
Per-frequency cross-batch stat transfer on Q/K/V + `prototype_tokens` pooling.
Not used by either node's recommended preset.

### Gap 7 — RF ref-prompt conditioning  ✗
Swift reuses the target prompt for the ref batch (degenerate single-prompt).
Upstream `_build_rf_conditioning_kwargs` slices ref-only text+mask. Matters only
if ref has its own prompt (Swift always uses one prompt).

## Composition with ControlNet
**nodes.py has zero ControlNet handling.** `control` appears only as a kwarg
pass-through in `_raw_transformer_velocity`. The style-transfer patch does not
inspect, branch on, or compensate for a Control LoRA. So the composition arc's
"LoRA suppresses style palette" finding is an emergent base-model interaction,
not something upstream addresses — confirming it is genuine, not a port bug.

## flux2 gap (separate director)
`swift/flux2-image-director/Flux2Style.swift` is **NOT** a K/V-injection
mechanism — it is prompt presets + Flux2KleinEdit reference conditioning (i2i-
style "see the input every step") + a style-bias prompt. flux2 has **no**
training-free K/V attention injection at all, and the LoRA path (anime2real) is
deferred. → The krea2 K/V-injection mechanism (V-AdaIN + K-scale + Q/K-AdaIN) is
architecturally portable to flux2's transformer (it operates on attention Q/K/V,
which any DiT has), but that is a substantial separate arc.

## Prioritized plan
1. **This arc — krea2 Q/K-AdaIN port** (Gap 1): add `adainStrength` knob (default
   0.85) + the cross-batch Q/K AdaIN in `styledAttention`, with
   `effective_adain = clamp(adainStrength·min(strength,1.25),0,1)`. Re-confirm the
   strength=0 byte-identical corruption gate. Test: does Q/K-AdaIN (a) strengthen
   the style-only palette shift, (b) recover the palette under the Control LoRA
   (the composition arc's open question)?
2. **Follow-up A — dual-ref** (Gap 2): port `multi_delta` + `step_cycle` +
   `primary_reference`. Larger; needs 2-ref RF cache + delta fusion.
3. **Follow-up B — flux2 K/V-injection port** → then `s2-agent-ext-flux2` exposes
   a real style-transfer command (today its `style` maps only to the weak
   Flux2KleinEdit path). Substantial; separate arc.
4. Minor: strength-rescaling (Gap 5), other RF modes (Gap 3).
