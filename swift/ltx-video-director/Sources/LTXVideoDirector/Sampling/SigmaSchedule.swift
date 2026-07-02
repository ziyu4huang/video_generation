//
//  SigmaSchedule.swift
//  LTXVideoDirector
//
//  Native port of the LTX-2 sigma schedule helpers:
//    - DISTILLED_SIGMAS / STAGE_2_SIGMAS (ltx_pipelines_mlx.scheduler) —
//      literal constant tables for the fast distilled/stage-2 paths.
//    - dynamicShiftSchedule (mlx_arsenal.diffusion.dynamic_shift_schedule,
//      wrapped by ltx_pipelines_mlx.scheduler.ltx2_schedule) — the
//      token-count-adaptive flow-matching schedule used by the dev/HQ path.
//

import Foundation

public enum SigmaSchedule {
    /// Predefined sigma schedule for the 8-step distilled model.
    /// 9 values = 8 steps (iterate consecutive pairs).
    public static let distilledSigmas: [Float] = [
        1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0,
    ]

    /// Sigma schedule for stage-2 refinement (two-stage pipeline).
    /// 4 values = 3 steps.
    public static let stage2Sigmas: [Float] = [0.909375, 0.725, 0.421875, 0.0]

    /// Token-count-adaptive flow-matching sigma schedule (LTX-style).
    /// Interpolates a shift factor linearly between `baseShift` at
    /// `baseTokens` and `maxShift` at `maxTokens`, applies it to a
    /// descending linspace, then optionally stretches so the last non-zero
    /// sigma equals `1 - terminal`. Returns `numSteps + 1` values ending at 0.0.
    public static func dynamicShiftSchedule(
        numSteps: Int, numTokens: Int,
        baseShift: Float = 0.95, maxShift: Float = 2.05,
        baseTokens: Int = 1024, maxTokens: Int = 4096,
        stretch: Bool = true, terminal: Float = 0.1
    ) -> [Float] {
        var sigmas = (0...numSteps).map { i in Float(1.0) - Float(i) / Float(numSteps) }

        let slope = (maxShift - baseShift) / Float(maxTokens - baseTokens)
        let intercept = baseShift - slope * Float(baseTokens)
        let sigmaShift = Float(numTokens) * slope + intercept
        let expShift = exp(sigmaShift)

        for i in 0..<sigmas.count {
            if sigmas[i] != 0 {
                sigmas[i] = expShift / (expShift + (1.0 / sigmas[i] - 1.0))
            }
        }

        if stretch {
            let nonZeroIndices = sigmas.indices.filter { sigmas[$0] != 0 }
            if let lastIdx = nonZeroIndices.last {
                let oneMinusZLast = 1.0 - sigmas[lastIdx]
                let scaleFactor = oneMinusZLast / (1.0 - terminal)
                if scaleFactor != 0 {
                    for i in nonZeroIndices {
                        let oneMinusZ = 1.0 - sigmas[i]
                        sigmas[i] = 1.0 - (oneMinusZ / scaleFactor)
                    }
                }
            }
        }

        return sigmas
    }

    /// LTX-2 token-count-adaptive schedule with LTX's own defaults
    /// (max_shift=2.05, base_shift=0.95, num_tokens anchor=4096).
    public static func ltx2Schedule(
        steps: Int, numTokens: Int = 4096, maxShift: Float = 2.05,
        baseShift: Float = 0.95, stretch: Bool = true, terminal: Float = 0.1
    ) -> [Float] {
        dynamicShiftSchedule(
            numSteps: steps, numTokens: numTokens, baseShift: baseShift, maxShift: maxShift,
            stretch: stretch, terminal: terminal)
    }
}
