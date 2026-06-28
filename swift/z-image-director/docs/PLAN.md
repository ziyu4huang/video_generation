# Port Roadmap — run.py Z-Image T2I → Swift

Source of truth for the staged port. Each phase ends with a verifiable checkpoint.

## Phase 0 — Project scaffolding ✅

- [x] SwiftPM package (`Package.swift`, `zimage` executable + `ZImageDirector` library).
- [x] Dependencies: `mlx-swift` 0.31.4 (MLX/MLXNN/MLXRandom/MLXFast) + ArgumentParser.
      (Hub/Image/Tokenizers deferred — `mlx-swift-examples` split them into separate
      packages; add per-phase when needed.)
- [x] `zimage t2i` CLI skeleton (ArgumentParser) with defaults mirroring run.py.
- [x] **Metal kernels workaround**: SwiftPM can't compile metallib; reuse the
      Python venv's prebuilt `mlx.metallib` via `scripts/setup-metallib.sh`.
- Checkpoint: `swift build` succeeds; `zimage --help` prints usage.

## Phase 1 — Weight loading + config ✅

- [x] `TransformerConfig` decodes `config.json` (dim=3840, nheads=30, n_layers=30,
      n_refiner=2, in_channels=16, rope_theta=256, axes_dims=[32,48,48],
      t_scale=1000, cap_feat_dim=2560).
- [x] `ModelPaths` resolves the repo's `python/mlx-movie-director/models/transformer/<variant>/`
      (resolves symlink to external store transparently).
- [x] `WeightStore.load()` reads `model.safetensors` via `MLX.loadArrays(url:)`.
- [x] `WeightKeyAudit` validates all 1073 keys against architecture expectation
      (per-group counts: t_embedder=8, x_embedder=4, cap_embedder=5,
      noise_refiner=62, context_refiner=54, layers=930, final_layer=8, pads=1+1).
- [x] Spot-checked quantized-linear shapes: `layers.0.attention.to_q.weight` (3840,960) uint32,
      scales (3840,60) → group_size=64, bits=8.
- Checkpoint: ✅ `zimage t2i` loads moody-pro-mix, prints validated key audit.
      All 1073 keys matched, zero unexpected prefixes.

> **MLX weight format reference** (for Phase 2 module construction):
> Each quantized linear stores `weight` (uint32, packs 4× 8-bit), `scales`,
> `biases` (quantization offsets, NOT linear bias), and optional `bias`.
> mlx-swift's `QuantizedLinear.init(weight:bias:scales:biases:groupSize:bits:mode:)`
> accepts these directly — no dequantization needed.

## Phase 2 — Transformer core (largest scope)

Port `app/transformer.py` → Swift, layer by layer:

- [x] `RMSNorm` → `ZRMSNorm` (MLXFast.rmsNorm)
- [x] `TimestepEmbedder` (sinusoidal → Linear → SiLU → Linear)
- [x] `FeedForward` (SwiGLU: `w2(silu(w1(x)) * w3(x))`)
- [x] `Attention` (to_q/k/v/out, RoPE via reshape+split, qk_norm, fused QKV)
- [x] `ZImageTransformerBlock` (modulated + non-modulated paths)
- [x] `FinalLayer` (LayerNorm affine=False + adaLN)
- [x] `ZImageTransformer` (embedders + 2 noise refiners + 2 context refiners + 30 layers)
- [x] `TransformerWeightLoader` (safetensors dict → typed QuantizedLinear modules, + fuse_qkv)
- [x] `prepareRope` (cos/sin for all positions, [32,48,48] axis dims)
- [x] `Verify` harness + Python reference dump (`scripts/dump_transformer_reference.py`)
- Checkpoint: ✅ **ALL 19 checks pass** (`zimage verify`). Embedders/RoPE/context-refiners
      EXACT (relMax=0); single layer relMax 2.6e-6; deep layers relMax <1e-3;
      **final output relMax 3.4e-3, mean 1.1e-3**.

> **Phase 2 bugs found & fixed during verification:**
>
> 1. Block RMSNorm eps — Python uses default 1e-6 (NOT config norm_eps=1e-5);
>    only attention norm_q/norm_k use 1e-5.
> 2. Position indexing — `positions[..., k]` needs `positions[0...,0...,k]` (three
>    subscripts), not `positions[0..., k]` (which indexes dim 1).
> 3. RoPE even/odd extraction — use reshape→index, not strided indexing.
> 4. Verification metric — use RELATIVE tolerance (maxAbs / tensor magnitude),
>    not absolute; deep transformer layers compound abs error but stay accurate
>    relative to magnitude, and the final LayerNorm renormalizes.

## Phase 3 — Text encoder (deferred; see decision)

**Decision: start with Python-precomputed embeddings (embedding exchange).**

- [x] Defer full encoder port. Generate `.safetensors` prompt embeddings from Python
      (`app/text_encoder.py`) and feed them to the Swift transformer.
- [ ] (Later) Port the Qwen-based text encoder + tokenizer to pure Swift.

## Phase 4 — VAE decode ✅

- [x] `ZImageVAEDecoder` — full port of mflux z_image_vae decoder tree:
      ConvIn(16→512) → UNetMidBlock(+attention) → 4× UpDecoderBlock →
      ConvNormOut(128) → SiLU → ConvOut(128→3).
- [x] `LoadedConv2d` / `LoadedGroupNorm` — weight-injected primitives
      (NHWC layout, pytorch-compatible GroupNorm via MLXFast.layerNorm).
- [x] Latent preprocessing: `(latents / 0.3611) + 0.1159` (scaling_factor +
      shift_factor) applied before decode — matches `VAE.decode()`.
- [x] Pixel post-processing: `clip(decoded/2 + 0.5, 0, 1)`.
- [x] PNG save via CoreGraphics (`ImageSave.savePNG`).
- Checkpoint: ✅ **ALL 13 checks pass** (`zimage verify-vae`).
      conv_in EXACT; mid_block relMax 7e-3; conv_out relMax 1.1e-2;
      **final image relMax 7.8e-3, mean 9.7e-4**.

> **Phase 4 bugs found & fixed during verification:**
>
> 1. GroupNorm pytorch-compatible algorithm — must reshape→transpose→reshape
>    to (B, groups, S*groupSize) then layerNorm, NOT normalize over (groups, groupSize).
>    Directly mirrors mlx-swift's `GroupNorm.pytorchGroupNorm`.
> 2. Latent scale+shift — `VAE.decode()` divides by scaling_factor (0.3611) and
>    adds shift_factor (0.1159) BEFORE the decoder; skipping this made the raw
>    decode diverge (relMax 0.9) even though the decoder math was correct.
> 3. ConvNormOut/ConvOut transpose NCHW↔NHWC internally; the top-level forward
>    must pass NCHW (not pre-transpose — would double-transpose).

## Phase 5 — Denoise loop + CFG ✅

- [x] `FlowMatchEulerScheduler` — dynamic-shift timesteps + Euler step
      (port of `MLXFlowMatchEulerScheduler`).
- [x] `PositionGrid.create` — `create_coordinate_grid` (img + cap positions).
- [x] `LatentOps.patchify` / `unpack` — the reshape/transpose wraps around the
      transformer call (Flux latent format).
- [x] `T2IPipeline.generate` — full denoise loop, optional CFG, MLXRandom seed
      OR fixed-noise input (for reproducible comparison).
- [x] `ImageSave.savePNG` — (1,3,H,W) float32 → PNG via CoreGraphics.
- [x] `zimage t2i` — end-to-end CLI: loads transformer + VAE + prompt embedding,
      denoises, decodes, writes PNG.
- [x] **Classifier-free guidance** — `--uncond` embedding dump + CFG blend
      (`uncond + scale*(cond-uncond)`), verified against Python.
- [x] **Per-step timing instrumentation** (ms/it, running average).
- Checkpoint: ✅ **all four verifies pass** (`verify`, `verify-vae`,
      `verify-t2i`, `verify-t2i --cfg-scale 4.0`). With IDENTICAL input noise, the Swift image is **97.1%
      pixel-identical to Python** (match@5/255), correlation 0.9985, mean diff
      1.06/255. Per-step latent drift: step1 relMax 3.3e-4 → step3 4.8e-2;
      step4 relMax 0.17 on outliers (mean 8e-3) — inherent turbo-model chaos
      from the final step's large dt, NOT a port bug (decodes to <1% pixel diff).
      **CFG mode (cfg=4.0)** is even tighter: final relMax 4.2e-2, decoded image
      **100% pixel-identical within ±5/255**, correlation 0.9998, mean diff 0.29/255.

> **Phase 5 performance finding:** Swift runs at **1.23 s/it** (cfg-off) and
> **3.41 s/it** (cfg-on, 2 forward passes) — essentially identical to Python's
> 1.24 s/it. They share the same MLX Metal kernels, so there is no compile
> penalty to recover; `@mx.compile` is not needed for parity.
>
> **Phase 5 key insight — noise determinism:**
> The Python pipeline seeds `numpy.random` (CPU), the Swift pipeline seeds
> `MLXRandom` (Metal). These produce DIFFERENT byte streams for the same seed
> number, so `--seed 99` in Swift ≠ `--seed 99` in Python. To compare outputs
> bit-accurately, pass the Python noise via `--noise-file` (dumped by numpy).
> The divergence people attribute to "port bugs" in diffusion ports is almost
> always this noise-source mismatch, not the model math.

## Phase 3 — Text encoder + tokenizer ✅

- [x] `Qwen3TextEncoder` — full port of Qwen3-4B decoder transformer (36 layers,
      GQA 32/8 heads, RoPE, qk_norm, SwiGLU). Returns last-layer hidden state.
      Uses `quantizedMM` + `dequantized` for 4-bit group_size=32 weights.
- [x] `BPETokenizer` — GPT-2 byte-level BPE with GPT-4 pre-tokenizer regex,
      151K vocab + 151K merges, special token splitting, Qwen3 chat template.
- [x] `zimage verify-tokenizer` — 100% token match against Python.
- [x] `zimage verify-encoder` — real prompt cap_feats **bit-identical** (relMax 0.0).
- [x] E2E: `zimage t2i --prompt "text"` (no `--embedding`) works — text → tokens →
      encoder → transformer → VAE → PNG, all pure Swift.
- Checkpoint: ✅ all **5 verifies pass**. With identical noise, E2E image
      correlation **0.99977**, 100% pixel match within ±5/255.

> **Phase 3 key decisions:**
>
> 1. The BPE merge algorithm must work on `[String]` not `[Character]` —
>    merged tokens are multi-character strings (e.g. "Ġcinematic").
> 2. `hidden_states[-2]` in Python = the LAST layer output (before final norm),
>    not the second-to-last layer. Off-by-one trap.
> 3. GQA expansion: use broadcast+reshape, not `repeated()` (wrong semantics).

## End state

Pure-Swift, Metal-accelerated Z-Image T2I is **fully E2E**: text → image with
zero Python runtime dependency.

```bash
zimage t2i --prompt "a portrait of a woman" --seed 99 --output out.png
```

Matching Python MLX to correlation 0.99977 with identical noise.

## Validation strategy

- Anchor every phase to a Python self-test / fixed-seed reference.
- For Phase 2–4 (no encoder), use a frozen embedding file to isolate correctness.
- Only declare a phase done when the numerical checkpoint passes.
