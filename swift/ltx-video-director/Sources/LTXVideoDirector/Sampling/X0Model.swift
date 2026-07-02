//
//  X0Model.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.model.X0Model — wraps
//  LTXModel's velocity prediction into an x0 (clean-sample) prediction:
//  given x_t = x0 + sigma*v, x0 = x_t - sigma*v. This is what the
//  denoise loop's Euler stepper actually consumes.
//
//  Scope matches LTXModel: scalar-timestep only (no per-token timesteps —
//  the reference's per-token branch is for partial-conditioning masks,
//  out of scope until Phase 3's I2V-conditioning sub-item lands).
//

import MLX

public struct X0Model {
    public let model: LTXModel

    public init(model: LTXModel) {
        self.model = model
    }

    /// Predict (videoX0, audioX0) from noisy (videoLatent, audioLatent) at `sigma`.
    public func callAsFunction(
        videoLatent: MLXArray, audioLatent: MLXArray, sigma: MLXArray,
        videoTextEmbeds: MLXArray? = nil, audioTextEmbeds: MLXArray? = nil,
        videoPositions: MLXArray? = nil, audioPositions: MLXArray? = nil,
        videoAttentionMask: MLXArray? = nil, audioAttentionMask: MLXArray? = nil
    ) -> (videoX0: MLXArray, audioX0: MLXArray) {
        let (videoV, audioV) = model(
            videoLatent: videoLatent, audioLatent: audioLatent, timestep: sigma,
            videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
            videoPositions: videoPositions, audioPositions: audioPositions,
            videoAttentionMask: videoAttentionMask, audioAttentionMask: audioAttentionMask)

        let videoSigma = sigma.reshaped([sigma.dim(0), 1, 1]).asType(.float32)
        let audioSigma = videoSigma

        let videoX0 = (videoLatent.asType(.float32) - videoSigma * videoV.asType(.float32)).asType(videoLatent.dtype)
        let audioX0 = (audioLatent.asType(.float32) - audioSigma * audioV.asType(.float32)).asType(audioLatent.dtype)
        return (videoX0, audioX0)
    }
}
