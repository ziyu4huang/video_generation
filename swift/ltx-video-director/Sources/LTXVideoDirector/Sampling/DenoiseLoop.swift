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
