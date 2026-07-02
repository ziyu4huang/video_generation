//
//  EulerDiffusionStep.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.components.diffusion_steps.EulerDiffusionStep
//  (+ ltx_core_mlx.utils.diffusion.to_velocity) — the first-order Euler
//  flow-match sampler step used by the fast distilled/dasiwa denoise loop
//  (Phase 3: diffusion sampling loop). Advances one step from sigma to
//  sigma_next via `sample + velocity * dt` where
//  `velocity = (sample - denoised) / sigma`.
//
//  NOT YET PORTED: Res2sDiffusionStep (second-order SDE sampler, used by
//  --hq) and EulerCfgPpDiffusionStep (CFG++ ancestral sampler) — this is
//  the simplest/most-used step, ported first per the smallest-to-largest
//  pattern established in Phase 1/2.
//

import MLX

public enum EulerDiffusionStep {
    /// (sample - denoised) / sigma, computed in fp32 then cast back to sample's dtype.
    public static func toVelocity(sample: MLXArray, sigma: Float, denoisedSample: MLXArray) -> MLXArray {
        precondition(sigma != 0, "Sigma can't be 0.0")
        let outDtype = sample.dtype
        return ((sample.asType(.float32) - denoisedSample.asType(.float32)) / sigma).asType(outDtype)
    }

    /// Advance `sample` from `sigmas[stepIndex]` to `sigmas[stepIndex+1]`.
    public static func step(sample: MLXArray, denoisedSample: MLXArray, sigmas: [Float], stepIndex: Int) -> MLXArray {
        let sigma = sigmas[stepIndex]
        let sigmaNext = sigmas[stepIndex + 1]
        let dt = sigmaNext - sigma
        let velocity = toVelocity(sample: sample, sigma: sigma, denoisedSample: denoisedSample)
        let outDtype = sample.dtype
        return (sample.asType(.float32) + velocity.asType(.float32) * dt).asType(outDtype)
    }
}
