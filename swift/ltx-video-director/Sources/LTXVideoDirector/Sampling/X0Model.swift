//
//  X0Model.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.model.X0Model — wraps
//  LTXModel's velocity prediction into an x0 (clean-sample) prediction:
//  given x_t = x0 + sigma*v, x0 = x_t - sigma*v. This is what the
//  denoise loop's Euler stepper actually consumes.
//
//  Supports per-token timesteps (videoTimesteps/audioTimesteps): when
//  provided, preserved tokens (timestep=0) get x0 = x_t - 0*v = x_t
//  (unchanged), matching the reference exactly — this is what keeps I2V
//  conditioning consistent between the model's own AdaLN modulation and
//  the x0 computation (both see timestep=0 for preserved tokens, not just
//  applyDenoiseMask papering over it afterward).
//

import MLX

public struct X0Model {
    public let model: LTXModel

    public init(model: LTXModel) {
        self.model = model
    }

    /// Predict (videoX0, audioX0) from noisy (videoLatent, audioLatent) at `sigma`.
    /// `videoTimesteps`/`audioTimesteps` (B, N), when provided, are used for
    /// both the model's AdaLN modulation (via LTXModel) AND the per-token
    /// sigma in the x0 formula (`video_timesteps[:,:,None]` instead of
    /// `sigma[:,None,None]`) — matching the reference's X0Model exactly.
    public func callAsFunction(
        videoLatent: MLXArray, audioLatent: MLXArray, sigma: MLXArray,
        videoTextEmbeds: MLXArray? = nil, audioTextEmbeds: MLXArray? = nil,
        videoPositions: MLXArray? = nil, audioPositions: MLXArray? = nil,
        videoAttentionMask: MLXArray? = nil, audioAttentionMask: MLXArray? = nil,
        videoTimesteps: MLXArray? = nil, audioTimesteps: MLXArray? = nil
    ) -> (videoX0: MLXArray, audioX0: MLXArray) {
        let (videoV, audioV) = model(
            videoLatent: videoLatent, audioLatent: audioLatent, timestep: sigma,
            videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
            videoPositions: videoPositions, audioPositions: audioPositions,
            videoAttentionMask: videoAttentionMask, audioAttentionMask: audioAttentionMask,
            videoTimesteps: videoTimesteps, audioTimesteps: audioTimesteps)

        let videoSigma = videoTimesteps.map { $0.expandedDimensions(axis: -1).asType(.float32) }
            ?? sigma.reshaped([sigma.dim(0), 1, 1]).asType(.float32)
        let audioSigma = audioTimesteps.map { $0.expandedDimensions(axis: -1).asType(.float32) }
            ?? sigma.reshaped([sigma.dim(0), 1, 1]).asType(.float32)

        let videoX0 = (videoLatent.asType(.float32) - videoSigma * videoV.asType(.float32)).asType(videoLatent.dtype)
        let audioX0 = (audioLatent.asType(.float32) - audioSigma * audioV.asType(.float32)).asType(audioLatent.dtype)
        return (videoX0, audioX0)
    }
}
