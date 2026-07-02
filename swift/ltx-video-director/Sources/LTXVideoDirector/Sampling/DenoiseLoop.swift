//
//  DenoiseLoop.swift
//  LTXVideoDirector
//
//  Native port of ltx_pipelines_mlx.utils.samplers.denoise_loop — the
//  Euler denoising loop for joint audio+video diffusion, tying together
//  X0Model (Phase 3) + EulerDiffusionStep (Phase 3) + a sigma schedule.
//
//  Scope: the "uniform denoise mask" case only (full T2V/I2V generation,
//  no partial-frame conditioning) — `apply_denoise_mask` is an identity
//  when mask=1 everywhere, so it's omitted here rather than ported as a
//  no-op. Per-token timesteps (for partial conditioning) are likewise out
//  of scope, matching X0Model/LTXModel's current scope.
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

    /// Reference: mlx_arsenal.diffusion.euler_step —
    /// x_{t-1} = x + (sigma_next - sigma) * (x - x0) / sigma.
    private static func eulerStep(x: MLXArray, x0: MLXArray, sigma: Float, sigmaNext: Float) -> MLXArray {
        let d = (x - x0) / sigma
        return x + (sigmaNext - sigma) * d
    }
}
