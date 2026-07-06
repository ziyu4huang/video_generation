//
//  DenoiseLoop.swift
//  LTXVideoDirector
//
//  Native port of ltx_pipelines_mlx.utils.samplers.denoise_loop — the
//  Euler denoising loop for joint audio+video diffusion, tying together
//  X0Model (Phase 3) + EulerDiffusionStep (Phase 3) + a sigma schedule.
//
//  Scope: `run(...)` covers the "uniform denoise mask" case (full T2V/I2V
//  generation from pure noise, no partial-frame conditioning) —
//  `apply_denoise_mask` is an identity when mask=1 everywhere, so it's
//  omitted there. `run(model:videoState:audioState:...)` covers I2V
//  conditioning (non-uniform masks, via LatentConditioning.swift), calling
//  `applyDenoiseMask` after every step so preserved tokens (e.g. the
//  conditioning frame) snap back to their clean values regardless of what
//  the model predicted for them.
//
//  The conditioned overload uses per-token timesteps (X0Model/LTXModel
//  support them — see their headers) whenever a state's denoise mask is
//  non-uniform, matching the reference's `_is_uniform_mask` branch exactly:
//  preserved tokens get timestep=0 (no AdaLN modulation), generated tokens
//  get timestep=sigma. Reference: `_compute_per_token_timesteps` =
//  `(denoise_mask * sigma).squeeze(-1)`.
//

import MLX

public struct DenoiseResult {
    public let videoLatent: MLXArray
    public let audioLatent: MLXArray
}

public enum DenoiseLoop {
    /// Run the Euler denoising loop. `sigmas` already includes the terminal
    /// value (e.g. 0.0) — steps are formed from consecutive pairs
    /// `zip(sigmas[:-1], sigmas[1:])`, matching the reference exactly.
    public static func run(
        model: X0Model,
        videoLatent: MLXArray, audioLatent: MLXArray,
        videoTextEmbeds: MLXArray, audioTextEmbeds: MLXArray,
        sigmas: [Float],
        videoPositions: MLXArray? = nil, audioPositions: MLXArray? = nil,
        videoAttentionMask: MLXArray? = nil, audioAttentionMask: MLXArray? = nil
    ) -> DenoiseResult {
        var videoX = videoLatent
        var audioX = audioLatent
        let b = videoX.dim(0)

        for i in 0..<(sigmas.count - 1) {
            let sigma = sigmas[i]
            let sigmaNext = sigmas[i + 1]
            let sigmaArray = MLXArray(Array(repeating: sigma, count: b))

            let (videoX0, audioX0) = model(
                videoLatent: videoX, audioLatent: audioX, sigma: sigmaArray,
                videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
                videoPositions: videoPositions, audioPositions: audioPositions,
                videoAttentionMask: videoAttentionMask, audioAttentionMask: audioAttentionMask)

            if sigma == 0 {
                videoX = videoX0
                audioX = audioX0
            } else {
                videoX = eulerStep(x: videoX, x0: videoX0, sigma: sigma, sigmaNext: sigmaNext)
                audioX = eulerStep(x: audioX, x0: audioX0, sigma: sigma, sigmaNext: sigmaNext)
            }
            MLX.eval(videoX, audioX)
        }

        return DenoiseResult(videoLatent: videoX, audioLatent: audioX)
    }

    /// Same loop, but conditioned via `LatentState` (I2V: preserved tokens
    /// snap back to `cleanLatent` after every step via `applyDenoiseMask`).
    /// Positions/attention masks come from the states themselves, matching
    /// the reference denoise_loop's own fallback (`video_state.positions`
    /// used when the explicit `videoPositions` param is nil).
    public static func run(
        model: X0Model,
        videoState: LatentState, audioState: LatentState,
        videoTextEmbeds: MLXArray, audioTextEmbeds: MLXArray,
        sigmas: [Float],
        videoAttentionMask: MLXArray? = nil, audioAttentionMask: MLXArray? = nil
    ) -> DenoiseResult {
        var videoX = videoState.latent
        var audioX = audioState.latent
        let b = videoX.dim(0)
        let vMask = videoAttentionMask ?? videoState.attentionMask
        let aMask = audioAttentionMask ?? audioState.attentionMask

        let videoUniform = isUniformMask(videoState.denoiseMask)
        let audioUniform = isUniformMask(audioState.denoiseMask)

        for i in 0..<(sigmas.count - 1) {
            let sigma = sigmas[i]
            let sigmaNext = sigmas[i + 1]
            let sigmaArray = MLXArray(Array(repeating: sigma, count: b))

            let videoTimesteps = videoUniform ? nil : perTokenTimesteps(sigma: sigma, denoiseMask: videoState.denoiseMask)
            let audioTimesteps = audioUniform ? nil : perTokenTimesteps(sigma: sigma, denoiseMask: audioState.denoiseMask)

            var (videoX0, audioX0) = model(
                videoLatent: videoX, audioLatent: audioX, sigma: sigmaArray,
                videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
                videoPositions: videoState.positions, audioPositions: audioState.positions,
                videoAttentionMask: vMask, audioAttentionMask: aMask,
                videoTimesteps: videoTimesteps, audioTimesteps: audioTimesteps)

            videoX0 = applyDenoiseMask(x0: videoX0, cleanLatent: videoState.cleanLatent, denoiseMask: videoState.denoiseMask)
            audioX0 = applyDenoiseMask(x0: audioX0, cleanLatent: audioState.cleanLatent, denoiseMask: audioState.denoiseMask)

            if sigma == 0 {
                videoX = videoX0
                audioX = audioX0
            } else {
                videoX = eulerStep(x: videoX, x0: videoX0, sigma: sigma, sigmaNext: sigmaNext)
                audioX = eulerStep(x: audioX, x0: audioX0, sigma: sigma, sigmaNext: sigmaNext)
            }
            MLX.eval(videoX, audioX)
        }

        return DenoiseResult(videoLatent: videoX, audioLatent: audioX)
    }

    /// Same conditioned loop as `run(model:videoState:audioState:...)`, but
    /// for a REAL checkpoint too large to hold all 48 blocks' dequantized
    /// weights resident at once: at every sigma step, `blockProvider`
    /// rebuilds each of `numLayers` blocks from its raw checkpoint slice
    /// (see `TransformerCheckpointLoader.blockWeights`) via
    /// `LTXModel.streamingForward`, exactly like `LTXModelRealCheckpointTests
    /// .testAll48RealBlocksStreamWithBoundedMemory` proves works for one
    /// forward pass — this just repeats that per denoise step.
    ///
    /// `LTXModel.streamingForward` now accepts per-token timesteps (mirrors
    /// `callAsFunction`), so — exactly like the non-streaming conditioned
    /// `run` above — preserved I2V conditioning tokens get timestep=0 (no
    /// AdaLN modulation) and are correctly seen as "clean" by every other
    /// token's cross-attention during the forward pass, not just corrected
    /// in the output afterward via `applyDenoiseMask`.
    ///
    /// `cachedBlockCount` bounds an opt-in cache of the FIRST `n` blocks'
    /// dequantized+LoRA-fused weights across sigma steps (default 0 =
    /// unchanged streaming behavior — every block rebuilt from the raw
    /// checkpoint every step, zero behavior/memory change from before this
    /// parameter existed).
    ///
    /// **Measured, not just theorized — and the measurement says this is a
    /// memory-headroom-dependent tradeoff, not a free win:**
    /// - Caching all 48 blocks (`cachedBlockCount: numLayers`) was measured
    ///   end-to-end on a real i2v generation: it holds ~88GB of
    ///   simultaneously-resident dequantized weights on this 22B-class
    ///   model, and on this machine that drove free memory to ~0 and
    ///   triggered real disk swap — a ~30-40% wall-time REGRESSION, not a
    ///   speedup, because swap I/O cost dwarfed the redundant-dequant
    ///   savings.
    /// - A bounded prefix (`cachedBlockCount` small, e.g. 2 or 8) was
    ///   expected to sidestep this by capping the extra resident footprint
    ///   to `cachedBlockCount × ~1.8GB`. In practice, tested at
    ///   `cachedBlockCount` 2 and 8 on a machine that already had ~40GB+
    ///   claimed by unrelated background processes (browser, editor, etc.,
    ///   leaving ~86GB nominally free but little real headroom once this
    ///   pipeline's own baseline footprint — T2I model, text encoder, the
    ///   19GB raw transformer checkpoint, VAE/vocoder — is accounted for):
    ///   even `cachedBlockCount: 2` measurably increased `sysctl
    ///   vm.swapusage`'s `used` figure during the run (new swap growth, not
    ///   just pre-existing residual swap) and was slightly slower than
    ///   `cachedBlockCount: 0`, not faster.
    /// - **Conclusion: whether any non-zero `cachedBlockCount` is a net win
    ///   depends on how much real free memory exists at generation time,
    ///   which this codebase has no way to detect or adapt to today.**
    ///   That's why the default is 0 (unconditionally safe) rather than
    ///   some small "should be fine" constant — a future caller wiring this
    ///   up should re-run the same before/after wall-time + `vm.swapusage`
    ///   delta measurement on ITS target machine, ideally with a
    ///   memory-headroom check (e.g. only enable when several tens of GB
    ///   are genuinely free), before choosing a non-zero value.
    /// - Parameters:
    ///   - uncondVideoTextEmbeds: Negative-prompt video text embeds (e.g.
    ///     `NativeTextEncodeStage.encode(CFGGuidance.defaultNegativePrompt)`).
    ///     When non-nil and `cfgScale` is active, an extra unconditional
    ///     forward pass runs every step and is blended in via
    ///     `CFGGuidance.blend` — Milestone 2a of the CFG/STG port (video
    ///     guidance only; audio and STG/modality guidance are not covered,
    ///     see `docs/native-i2v-dev-variant-study.md`).
    ///   - cfgScale: Classifier-free guidance scale. `1.0` (default) means
    ///     no guidance — behavior-identical to before this parameter existed.
    ///   - rescaleScale: Variance-preserving rescale strength applied after
    ///     the CFG blend (`0` disables rescaling). Ignored when CFG is
    ///     inactive.
    public static func runStreaming(
        model: LTXModel, numLayers: Int, blockProvider: (Int) -> BasicAVTransformerBlock,
        videoState: LatentState, audioState: LatentState,
        videoTextEmbeds: MLXArray, audioTextEmbeds: MLXArray,
        sigmas: [Float],
        videoAttentionMask: MLXArray? = nil, audioAttentionMask: MLXArray? = nil,
        audioOnly: Bool = false,
        cachedBlockCount: Int = 0,
        uncondVideoTextEmbeds: MLXArray? = nil,
        cfgScale: Float = 1.0,
        rescaleScale: Float = 0.0
    ) -> DenoiseResult {
        var videoX = videoState.latent
        var audioX = audioState.latent
        let b = videoX.dim(0)
        let vMask = videoAttentionMask ?? videoState.attentionMask
        let aMask = audioAttentionMask ?? audioState.attentionMask

        let videoUniform = isUniformMask(videoState.denoiseMask)
        let audioUniform = isUniformMask(audioState.denoiseMask)

        var blockCache: [Int: BasicAVTransformerBlock] = [:]
        let cfgActive = uncondVideoTextEmbeds != nil && CFGGuidance.isActive(cfgScale: cfgScale)

        return withoutActuallyEscaping(blockProvider) { blockProvider in
            let effectiveBlockProvider: (Int) -> BasicAVTransformerBlock = cachedBlockCount <= 0 ? blockProvider : { idx in
                if let cached = blockCache[idx] { return cached }
                let block = blockProvider(idx)
                if idx < cachedBlockCount { blockCache[idx] = block }
                return block
            }

            for i in 0..<(sigmas.count - 1) {
                let sigma = sigmas[i]
                let sigmaNext = sigmas[i + 1]
                let sigmaArray = MLXArray(Array(repeating: sigma, count: b))

                let videoTimesteps = videoUniform ? nil : perTokenTimesteps(sigma: sigma, denoiseMask: videoState.denoiseMask)
                let audioTimesteps = audioUniform ? nil : perTokenTimesteps(sigma: sigma, denoiseMask: audioState.denoiseMask)

                let (videoV, audioV) = model.streamingForward(
                    videoLatent: videoX, audioLatent: audioX, timestep: sigmaArray,
                    numLayers: numLayers, blockProvider: effectiveBlockProvider,
                    videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
                    videoPositions: videoState.positions, audioPositions: audioState.positions,
                    videoAttentionMask: vMask, audioAttentionMask: aMask,
                    videoTimesteps: videoTimesteps, audioTimesteps: audioTimesteps,
                    audioOnly: audioOnly)

                let sigmaB = sigmaArray.reshaped([b, 1, 1]).asType(.float32)
                var videoX0 = (videoX.asType(.float32) - sigmaB * videoV.asType(.float32)).asType(videoX.dtype)
                var audioX0 = (audioX.asType(.float32) - sigmaB * audioV.asType(.float32)).asType(audioX.dtype)

                if cfgActive, let uncondVideoTextEmbeds {
                    // Second forward pass with the negative prompt (video
                    // stream only — audio guidance is a separate
                    // sub-milestone, see CFGGuidance.swift's header). The
                    // audio output of this pass is discarded.
                    let (uncondVideoV, _) = model.streamingForward(
                        videoLatent: videoX, audioLatent: audioX, timestep: sigmaArray,
                        numLayers: numLayers, blockProvider: effectiveBlockProvider,
                        videoTextEmbeds: uncondVideoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
                        videoPositions: videoState.positions, audioPositions: audioState.positions,
                        videoAttentionMask: vMask, audioAttentionMask: aMask,
                        videoTimesteps: videoTimesteps, audioTimesteps: audioTimesteps,
                        audioOnly: audioOnly)
                    let uncondVideoX0 = (videoX.asType(.float32) - sigmaB * uncondVideoV.asType(.float32)).asType(videoX.dtype)
                    videoX0 = CFGGuidance.blend(cond: videoX0, uncond: uncondVideoX0, cfgScale: cfgScale, rescaleScale: rescaleScale)
                }

                videoX0 = applyDenoiseMask(x0: videoX0, cleanLatent: videoState.cleanLatent, denoiseMask: videoState.denoiseMask)
                audioX0 = applyDenoiseMask(x0: audioX0, cleanLatent: audioState.cleanLatent, denoiseMask: audioState.denoiseMask)

                if sigma == 0 {
                    videoX = videoX0
                    audioX = audioX0
                } else {
                    videoX = eulerStep(x: videoX, x0: videoX0, sigma: sigma, sigmaNext: sigmaNext)
                    audioX = eulerStep(x: audioX, x0: audioX0, sigma: sigma, sigmaNext: sigmaNext)
                }
                MLX.eval(videoX, audioX)
            }

            return DenoiseResult(videoLatent: videoX, audioLatent: audioX)
        }
    }

    /// Reference: mlx_arsenal.diffusion.euler_step —
    /// x_{t-1} = x + (sigma_next - sigma) * (x - x0) / sigma.
    private static func eulerStep(x: MLXArray, x0: MLXArray, sigma: Float, sigmaNext: Float) -> MLXArray {
        let d = (x - x0) / sigma
        return x + (sigmaNext - sigma) * d
    }

    /// Reference: `_is_uniform_mask` — true iff the mask is all-ones (full
    /// denoise, no conditioning).
    private static func isUniformMask(_ mask: MLXArray) -> Bool {
        MLX.all(mask.asType(.float32) .== 1.0).item(Bool.self)
    }

    /// Reference: `_compute_per_token_timesteps` — preserved tokens (mask=0)
    /// get timestep=0, generated tokens (mask=1) get timestep=sigma.
    /// `denoiseMask` is (B, N, 1); returns (B, N).
    private static func perTokenTimesteps(sigma: Float, denoiseMask: MLXArray) -> MLXArray {
        (denoiseMask * sigma).squeezed(axis: -1)
    }
}
