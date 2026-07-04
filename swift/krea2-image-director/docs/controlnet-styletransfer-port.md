# Krea2 ControlNet + Style Transfer — MLX / pure-Swift port design

> Research → design for porting two ComfyUI krea2 features into
> `swift/krea2-image-director` as pure-native Swift/MLX. Studied 2026-07-04:
> - `facok/comfyui-krea2-controlnet` (the "LoRA抱脸地址": `Patil/Krea-2-depth-controlnet`)
> - `jieg9341-lab/ComfyUI-Krea2-StyleTransfer`

The two features could not be more different. One is a small **weighted adapter**
(LoRA); the other is a **training-free attention surgery** with no weights. Both
plug into the existing single-stream MMDiT (`Krea2DiT.swift`).

---

## Existing surface the port reuses (verified against current code)

- `Krea2DiT.callAsFunction(img, context, t, pos, mask)` — `img` is patchified
  latent tokens `(B, Ht*Wt, 64)`; the input projection is `lin(img, "first")`
  (Krea2DiT.swift:174). `lin()` auto-detects Q8 via `.weight.scales`.
- `Krea2Engine.t2i` / `Krea2Engine.i2i` — load DiT/VAE/encoder, flow-matching
  Euler loop (Krea2Engine.swift:84, Krea2I2I.swift:90).
- `Krea2I2I.loadImage` → `(1,H,W,3) [-1,1]`; `Krea2VAE.encode` → `(1,H,W,16)`
  channels-last native latent; `vaeMeanStd()` → diffusion-space `(mean,std)`.
- `Krea2Sampler.prepare` patchifies `(B,16,Hl,Wl)` → `(B, Ht*Wt, 64)` tokens.
- `RepoPaths.mlxModelsRoot` / `krea2Staging`; `loadArrays(url:)` → `[String: MLXArray]`.
- Convention: functional structs + `[String: MLXArray]` weight dict (NOT MLXNN.Module).

---

## Feature A — ControlNet (= Control LoRA)  ✦ smaller, weighted, ship first

### What it really is (from `nodes.py` + ref `pipeline.py`)
NOT a standalone ControlNet. It is a **rank-64 Control LoRA** with two parts:
1. An **expanded input projection** `first.weight (6144, 128)` — the noisy-image
   half `[:, :64]` (= the base model's own `first`) PLUS a new control half
   `[:, 64:]`. At the input, the control latent is patchified to 64-feature
   tokens and projected by the control half; the two halves ADD:
   `x = first_base(img_tokens) + first_control(control_tokens)`.
2. **224 rank-64 LoRA pairs** on every block's 8 linears
   (`attn.wq/wk/wv/wo/gate`, `mlp.gate/up/down`) for `blocks.0..27`.

**Injection is ONCE at the input projection — NOT per-block residuals.** No
timestep conditioning on the control path. After the input, the 28 blocks run
exactly as base krea2. (This corrects the surface-scan suggestion of per-block
residuals — the authoritative facok/pipeline.py mechanism is input-concat.)

### Weights
- HF: `Patil/Krea-2-depth-controlnet` / `depth-control-lora.safetensors` (862 MB).
- Tensors: `first.weight (6144,128)` [+ optional `first.bias`]; 224 pairs under
  `blocks.{i}.{target}.{lora_A,lora_B}.weight` (or one of 5 alt key conventions).
- α = rank = 64 → **scale = α/r = 1.0** (no scaling needed).
- Only **depth** checkpoint exists publicly; control-type is decided by the
  LoRA. A preprocessor (Depth-Anything-V2) is NOT included — caller supplies a
  depth-like image.

### Control image → control tokens (once per generation)
1. `loadImage` → `(1,H,W,3) [-1,1]`, resized to target `W×H`.
2. Preprocess (depth defaults): optional grayscale (`R·.299+G·.587+B·.114` rep);
   optional per-image minmax; optional invert (`1-x`). Rescale to `[-1,1]`.
3. `Krea2VAE.encode` → `(1,H,W,16)` native latent.
4. Diffusion normalize: `(z - mean) / std`.
5. Patchify `(1,16,Hl,Wl)` → `(1, Ht*Wt, 64)` control tokens (same as `prepare`).

### Swift implementation plan
- **`Krea2ControlLoRA.swift`** (new): load the LoRA safetensors. Extract
  `firstControl = first.weight[:, 64..128]` (store as `(6144,64)`). For each of
  the 224 targets, normalize A→`(r,in)` / B→`(out,r)` and insert into the DiT
  weight dict as `blocks.{i}.{target}.lora.A` / `.lora.B`. Tolerate the 6 key
  conventions + shape transpose (port `_lora_pairs`).
- **`Krea2DiT.lin`**: add one branch — if `w["\(prefix).lora.A"]` exists,
  `y += matmul(matmul(x, A.T), B.T)` (scale = 1). Two cheap rank-64 matmuls;
  keeps base Q8 weights untouched. Apply at the 8 attn/mlp linears per block.
- **`Krea2DiT.callAsFunction`**: add optional `controlTokens: MLXArray?`;
  `let x = lin(img, "first") + (controlTokens.map { controlLin($0) } ?? 0)`
  where `controlLin` = `matmul(ctrl, firstControl.T) [+ first.bias]`.
- **`Krea2Engine.controlnet(prompt:, controlImage:, strength:, ...)`**: like t2i
  but builds control tokens once and threads them into every `dit(...)` call.
  `strength` scales the control-half output (`controlLin * strength`).
- **`ControlNetCommand`** CLI: `--prompt`, `--control-image`, `--control-lora`,
  `--strength` (0..1), `--control-mode {rgb|gray}`, `--control-norm {none|minmax}`,
  `--control-invert`, plus shared `--width/--height/--steps/--seed`.
- **Weight path**: `mlx-models/transformer/krea2-depth-control-lora/model.safetensors`
  (promoted) → `_staging_krea2/depth-control-lora.safetensors` fallback. Download
  via the repo's HF helpers (CIVITAI-equivalent) on first use.

### Scope cuts
- Preprocessor (Depth-Anything-V2) stays external (user provides depth PNG).
- Single control image, single LoRA (no multi-control batching).
- `rgb` channel-mode + `none` normalize + no-invert + `match_latent_size` resize
  are the defaults; depth-friendly `gray+minmax` is one flag.

---

## Feature B — Style Transfer (training-free)  ✦ larger, weightless, phase 2

### What it really is (from `nodes.py`)
A **training-free K/V attention injection** — three mechanisms:
1. **Reference-Forecast (RF) cache**: before sampling, forward-integrate the
   style image's clean latent along the sampler's sigma grid using the **base
   model's own velocity** (Heun PC, γ=0.5, fixed noise seed=42). Produces a
   `{σ : ref_noisy}` cache. This is the project's distinguishing idea.
2. **2B batch-concat each step**: `x = concat([x_target, ref_noisy_σ])`,
  `context = concat([txt_target, txt_ref])`; run the full DiT on 2B; take `[:B]`.
3. **K/V injection in blocks 7..27**: in attention (after RoPE, pre-softmax),
   concat the reference batch's image-token K/V into the target's K/V:
   `k_t = concat([k_target, ref_k * scale_vec * ref_k_strength])`,
   `v_t = concat([v_target, ref_v_adain])`. A per-frequency `scale_vec` over
   head-dim gates low vs high freqs (the "no content leak" knob). V is
   AdaIN-mixed (ref stats → target, α=0.65) then raw-ref is injected (mix=1.0).

No weights. Monkey-patches the attention forward. Defaults: euler_ancestral,
steps=8, cfg=1.0.

### Swift implementation plan
- **RF cache**: `Krea2StyleCache.swift` — given `ref_clean` latent + the sampler
  sigmas, run a Heun predictor-corrector using `dit(...)` velocity, γ=0.5 blend
  with a linear prior `(1-σ)·ref_clean + σ·eps`. Store `{σ: z}`.
- **2B batching**: thread `refCleanOrNoisy` through `Krea2DiT` so each step
  builds a 2B `(img, context, t, pos, mask)` and slices `[:1]` out. Doubles
  memory + compute (no free lunch).
- **Attention surgery**: extend `Krea2DiT.attention` with an optional
  `StyleConfig` (target_b, img token range, scale_vec, ref_k_strength,
  value_adain_strength, active blocks set, sampler progress). For blocks in
  `7..27`: split target/ref batches, build concatenated K/V, run softmax once
  on the extended K/V. Skip Q/K AdaIN initially (V-AdaIN + K-scale is the
  primary mechanism per the repo's README).
- **`Krea2Engine.styleTransfer(prompt:, styleImage:, strength:, ...)`**:
  VAE-encode style → ref_clean; build RF cache; main loop fetches ref_noisy per
  σ and runs the 2B-style forward.
- **`StyleTransferCommand`** CLI: `--prompt`, `--style-image`, `--strength`
  (style_strength), plus `recommended`-mode baked defaults (the 13 numbers).

### Scope cuts (minimal viable port)
- Single reference only (`recommended` mode). Skip `multi_delta` / `stat` /
  dual-reference.
- Skip Q/K cross-batch AdaIN; keep V-AdaIN + K-scale (the core).
- Fixed `flowturbo_pc` integrator; no `rf_gamma`/`linear` alternates.

### Honest risk
RF cache ≈ doubles velocity evals (significant MPS cost). The "no content leak"
claim is empirical; the whole knob set (low_scale_end / ref_k_strength /
blocks 7-27) is leak mitigation. Worth measuring MPS overhead before committing
to the full port.

---

## Build sequence
1. **ControlNet vertical slice** (Feature A): Krea2ControlLoRA + DiT tweaks +
   engine + CLI + weight download. Build `-c release`; parity smoke (output
   shape + that control latent changes the output vs vanilla t2i at same seed).
2. **Style Transfer** (Feature B): RF cache + 2B batch + attention surgery.
   Build; smoke (output differs from t2i; style influence visible).
3. Run.py bridge subcommands + README.

## Open / deferred
- No real ComfyUI numerical-parity harness here (no mflux+krea2 python ref
  locally). Parity = "same seed, control ON vs OFF produces a deterministic,
  visibly-conditioned output" + tensor-shape asserts in a unit test (small
  config, like the existing Krea2DiT parity test pattern).
- Depth-Anything-V2 preprocessor port is a separate arc (out of scope here).
