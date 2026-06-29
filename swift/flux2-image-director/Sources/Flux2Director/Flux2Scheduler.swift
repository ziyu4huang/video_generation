//
//  Flux2Scheduler.swift
//  Flux2Director
//
//  Phase 2.4: Flow-match Euler discrete scheduler for Flux2 Klein.
//  Ported directly from mflux's flow_match_euler_discrete_scheduler.py.
//
//  Computes timesteps + sigmas via empirical-mu exponential time-shift, then
//  steps latents with: latents += (sigmas[t+1] - sigmas[t]) * noise.
//

import Foundation
import MLX

public struct Flux2Scheduler {
    public let timesteps: MLXArray   // (N,) — sigmas_final * 1000
    public let sigmas: MLXArray      // (N+1,) — last entry is 0
    public let numInferenceSteps: Int

    /// Build the scheduler for the given image sequence length + step count.
    public init(imageSeqLen: Int, numInferenceSteps: Int) {
        self.numInferenceSteps = numInferenceSteps
        let (ts, sg) = Self.getTimestepsAndSigmas(
            imageSeqLen: imageSeqLen, numInferenceSteps: numInferenceSteps)
        self.timesteps = ts
        self.sigmas = sg
    }

    /// Euler step: latents += (sigmas[t+1] - sigmas[t]) * noise.
    public func step(noise: MLXArray, timestep t: Int, latents: MLXArray) -> MLXArray {
        let dt = sigmas[t + 1] - sigmas[t]
        return latents + dt.asType(latents.dtype) * noise.asType(latents.dtype)
    }

    // MARK: - Sigma/timestep computation (static, matches mflux exactly)

    public static func getTimestepsAndSigmas(imageSeqLen: Int, numInferenceSteps: Int,
                                             numTrainTimesteps: Int = 1000)
        -> (timesteps: MLXArray, sigmas: MLXArray)
    {
        // sigmas = linspace(1.0, 1.0/N, N)  float32
        var sigmas = linspace(1.0, 1.0 / Double(numInferenceSteps), count: numInferenceSteps)
        let mu = empiricalMu(imageSeqLen: imageSeqLen, numSteps: numInferenceSteps)
        sigmas = timeShiftExponential(mu: mu, sigmaPower: 1.0, t: sigmas)
        let timesteps = sigmas * Float(numTrainTimesteps)
        // Append 0: sigmas = concat(sigmas, [0])
        let withZero = MLX.concatenated([sigmas, MLX.zeros([1])], axis: 0)
        return (timesteps.asType(.float32), withZero.asType(.float32))
    }

    static func empiricalMu(imageSeqLen: Int, numSteps: Int) -> Float {
        let a1: Float = 8.73809524e-05, b1: Float = 1.89833333
        let a2: Float = 0.00016927, b2: Float = 0.45666666
        if imageSeqLen > 4300 {
            return a2 * Float(imageSeqLen) + b2
        }
        let m200 = a2 * Float(imageSeqLen) + b2
        let m10 = a1 * Float(imageSeqLen) + b1
        let a = (m200 - m10) / 190.0
        let b = m200 - 200.0 * a
        return a * Float(numSteps) + b
    }

    /// exp(mu) / (exp(mu) + (1/t - 1)^sigmaPower)
    static func timeShiftExponential(mu: Float, sigmaPower: Float, t: MLXArray) -> MLXArray {
        let expMu = MLX.exp(MLXArray(mu))
        let inner = (1.0 / t) - 1.0
        let powered = MLX.pow(inner, MLXArray(sigmaPower))
        return expMu / (expMu + powered)
    }
}

/// linspace helper (MLX doesn't expose linspace directly in all versions).
func linspace(_ start: Double, _ stop: Double, count: Int) -> MLXArray {
    if count == 1 { return MLXArray(Float(start)) }
    let step = (stop - start) / Double(count - 1)
    var vals: [Float] = []
    vals.reserveCapacity(count)
    for i in 0..<count {
        vals.append(Float(start + Double(i) * step))
    }
    return MLXArray(vals)
}
