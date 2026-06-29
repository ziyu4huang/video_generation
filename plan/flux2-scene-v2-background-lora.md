# Plan (next iteration): flux2 scene v2 — background-as-canvas + multi-LoRA stack

> **Status (2026-06-30): ALL workflow functions shipped in native Swift flux2.**
> - WS1 `--bg` canvas + WS2 multi-LoRA merge — verified (commits `f9db820`).
> - **Phase C** seamless swap (`swap --inpaint`, masked denoise) — verified
>   (`19ae235`): VLM confirms no seam, background intact.
> - **Phase D** native Swift ESRGAN 4× (`flux2 upscale`, RealPLKSR port) —
>   verified (`ce56545`): PSNR 37.7 dB / cosine 0.99988 vs torch.
> - **Phase A** LoRAs: 7/12 of the 卡通转真人 stack downloaded+converted
>   (commits `32d9c8c`).
>
> **Open (decision pending, documented in swift/flux2-image-director/README.md
> "Known limitations"):**
> 1. ~~5/12 LoRAs~~ → **DONE 2026-06-30: 12/12 installed.** All 5 resolved
>    (LongFace_9B from NO8D/FaceControl; Colorful+qualitya from K-Slider pack;
>    DarkKlein r256 from redcraft pack; 亚洲人像 = NexBlend). See wave-2 plan.
> 2. ESRGAN has no tiled inference — whole-image only; very large inputs may OOM.
> 3. WS3 (per-ref strength + timestep gating) still deferred — not needed now.

> **Status (2026-06-29):** WS1 + WS2 IMPLEMENTED & verified end-to-end on the

> Continuation of the ComfyUI "三參考圖全能王" port. v1 (done 2026-06-29): z-image
> generates refs → `flux2 scene` composes via reference conditioning; shared `ImageGate`
> self-gates all outputs. This file = the three deferred TODOs, prioritized.
> Owner code paths are all under `swift/flux2-image-director/` + `swift/common-image-director/`.

## Context

v1 proved multi-reference composition works but with two honest gaps vs the original workflow:
1. **ref3 "background" only *steers* the environment** (it's a 3rd identity/scene reference). The
   user wants the background image to be the **actual canvas** the characters are placed into.
2. The original workflow **stacks 12 LoRAs** for quality; Swift loads only **one** LoRA.
3. (minor) References are injected with equal weight at all timesteps; the ComfyUI
   `ReferenceLatentPlus` node adds per-image strength + timestep gating.

Verified code facts that shape this plan:
- **flux2 has NO init-latent path.** Both `Flux2T2IPipeline.generate` (`Flux2T2IPipeline.swift:32`)
  and `Flux2EditPipeline.generate` (`Flux2T2IPipeline.swift:130`) start from pure noise via
  `Flux2LatentCreator.preparePackedLatents(seed:)`. "Edit" = VAE-encoded reference *tokens*
  concatenated to the noise — NOT an init latent. So background-as-canvas needs a **new
  partial-denoise (SDEdit-style) path** added to flux2 (mirrors z-image's `cleanLatent`/`denoiseStrength`).
- **Multi-LoRA merge is cheap & exact.** `Flux2Transformer.build(weights:lora:)`
  (`Flux2Transformer.swift:581`) takes one `Flux2LoRAAdapters`; runtime is `base + scale·(x·A)·B`
  per layer (`Flux2LoRA.swift`, F2QLinear). Stacking N LoRAs = represent `Σ scale_i·A_i·B_i` as one
  higher-rank adapter: `A_merged = hstack(sqrt(scale_i)·A_i)` (in, Σr), `B_merged = vstack(sqrt(scale_i)·B_i)`
  (Σr, out). Single-adapter code path unchanged; total rank = Σ r_i.

## Workstream 1 (primary) — background-as-canvas

Make `flux2 scene` treat one reference (default: the last `--ref`, or `--bg`) as an **init latent**
(inherits layout/environment as the actual canvas) while the other refs still supply identity
conditioning. Characters then emerge on top of the background via prompt + identity tokens.

### Implementation
- New `Flux2LatentCreator.encodeInitLatent(imagePath:targetSize:vaeEncoder:bn:)` — VAE-encode the
  background image → packed latent (reuse the encode half of `Flux2ReferenceConditioning.prepare`
  steps 1–6, `Flux2ReferenceConditioning.swift:34-55`), but this latent is the **denoise canvas**
  not a conditioning token.
- Extend `Flux2EditPipeline.generate` with optional `initLatent: MLXArray?` + `denoiseStrength: Float`:
  - When present, `current = addNoise(initLatent, sigmaAtStep(steps*(1-strength)))` instead of random
    noise; run the scheduler loop starting from that timestep (skip early steps). Mirror z-image
    `T2IPipeline.generate(cleanLatent:denoiseStrength:)` (`z-image T2IPipeline.swift:180-287`).
  - Reference tokens (the *other* refs) still concat as today for identity.
  - `denoiseStrength` semantics (same as z-image i2i): 0.3=light refine, 0.5=restyle keeping layout,
    0.7=loose redraw. For background+characters start ~0.55.
- `SceneCommand.swift`: add `@Option var bg: String?` (background ref) + `@Option var bgStrength: Float = 0.55`.
  If `--bg` set, that image becomes the init latent and is **removed** from the identity `refPaths`.
  Keep `--ref` for identity refs. Backward compatible: no `--bg` = current v1 behavior.
- Honesty note in run log: characters are placed by prompt + identity conditioning on the canvas;
  precise left/right placement still needs regional masks (Workstream-1b below, optional).

### Workstream 1b (optional, deferred) — regional character placement
True "圖一 left / 圖二 right" needs per-region reference injection (mask-guided). Big lift; keep
deferred unless 1 isn't sufficient. Note here so it's not forgotten.

## Workstream 2 — multi-LoRA stacking

Load + merge N LoRAs (the workflow's 12) so `flux2 scene`/`style` can stack quality LoRAs.

### Implementation
- `Flux2LoRA.swift`: add `Flux2LoRALoader.merge(_ loadeds: [(URL, Float)]) throws -> Flux2LoRAAdapters`
  — load each via existing `load(url:scale:)`, then per target key concatenate: `A=hstack(sqrt(s_i)·A_i)`,
  `B=vstack(sqrt(s_i)·B_i)`, `scale=1.0`. Result is a single `Flux2LoRAAdapters` with combined rank.
- `StyleCommand` / `SceneCommand`: change `--lora: String` → `--lora: [String]` (repeatable) +
  `--lora-scale: [Float]` (repeatable, one per LoRA). Resolve each via the existing
  `resolveLoRAFile(name:)` (`StyleCommand.swift:119`). Pass the merged adapters to
  `Flux2Transformer.build(weights:lora:)`. `SceneCommand` currently has no LoRA wiring — add it here.
- `RunConfig` already supports `loraPaths:[String]?` + `loraScales:[Float]?` — populate them.

## Workstream 3 (optional polish) — per-reference strength + timestep gating

Port `ReferenceLatentPlus` semantics.
- `--ref-strength: [Float]` (one per `--ref`): scale each ref's packed token values before concat in
  `Flux2ReferenceConditioning.prepare` (add a `strengths:[Float]?` param).
- `--ref-gate-steps: Float` (fraction of early steps where refs are injected): in the denoise loop,
  only concat ref tokens while `t/steps < gate`; else run noise-only. (Timestep gating.)

## Files to modify / add

| WS | Action | Path |
|---|---|---|
| 1 | **ADD** init-latent encode | `swift/flux2-image-director/Sources/Flux2Director/Flux2LatentCreator.swift` (+`Flux2ReferenceConditioning` reuse) |
| 1 | extend generate | `Sources/Flux2Director/Flux2T2IPipeline.swift` (`Flux2EditPipeline.generate` + init latent / partial denoise) |
| 1 | CLI | `Sources/Flux2DirectorCLI/SceneCommand.swift` (`--bg`, `--bg-strength`) |
| 2 | **ADD** merge | `Sources/Flux2Director/Flux2LoRA.swift` (`Flux2LoRALoader.merge`) |
| 2 | CLI | `SceneCommand.swift` + `StyleCommand.swift` (`--lora [String]`, `--lora-scale [Float]`) |
| 3 | conditioning | `Sources/Flux2Director/Flux2ReferenceConditioning.swift` (`strengths`, gate-steps) + denoise loop |
| — | docs | update `swift/flux2-image-director/README.md` (scene `--bg` / multi-LoRA) |

## Verification

1. Build release both packages: `swift build -c release` (debug = metallib crash, see memory).
2. **WS1**: `flux2 scene --ref ref1_charA.png --ref ref2_charB.png --bg ref3_bg.png --bg-strength 0.55 --prompt "..."` →
   output inherits ref3's classroom *layout/POV as the canvas* (not just tone), characters on top.
   A/B vs v1 (no `--bg`): canvas run should visibly retain ref3 composition structure. Gate all PASS.
3. **WS2**: `flux2 scene --ref ... --lora loraA --lora loraB --lora-scale 0.8 --lora-scale 1.0 --prompt ...`
   loads 2 LoRAs (printed `adapters=N`); confirm both applied (e.g. both effects visible / adapter count ≈ 2× single).
   Sanity: a single `--lora` still matches today's output (merge of 1 == direct load).
4. **WS3** (if done): `--ref-strength 1.0 0.4` weights ref2 lower; `--ref-gate-steps 0.5` injects refs only first half.
5. Re-run `scripts/multiref-scene.sh` with the new `--bg`/multi-LoRA flags → regenerate `scene-gallery.html`
   (self-gated, badges green) showing the improved background + stacked LoRAs.

## Out of scope (stays deferred)
- Regional/per-character mask placement (Workstream 1b).
- Anything ComfyUI-specific we already decided against (KV-cache node, FP8 — N/A on MLX).
