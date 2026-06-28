//
//  Scheduler.swift
//  ZImageDirector
//
//  Phase 5: FlowMatch Euler scheduler (port of MLXFlowMatchEulerScheduler).
//

import Foundation
import MLX

/// Flow-matching Euler scheduler with dynamic time-shifting.
/// Port of app/pipeline.py:MLXFlowMatchEulerScheduler.
public final class FlowMatchEulerScheduler {

    public let shift: Float
    public let useDynamicShifting: Bool
    public private(set) var timesteps: MLXArray?

    public init(shift: Float = 3.0, useDynamicShifting: Bool = true) {
        self.shift = shift
        self.useDynamicShifting = useDynamicShifting
    }

    /// Compute the timestep schedule. `mu` comes from calculateShift().
    public func setTimesteps(numSteps: Int, mu: Float? = nil) {
        // ts = linspace(1.0, 0.0, steps+1)
        var ts = (0...numSteps).map { Float($0) / Float(numSteps) }
        ts = ts.reversed().map { 1.0 - $0 + 0.0 }  // linspace(1→0)
        // The above yields 1.0, 1-1/n, ..., 0.0 — i.e. linspace(1,0,steps+1).
        ts = (0...numSteps).map { 1.0 - Float($0) / Float(numSteps) }

        if useDynamicShifting, let mu = mu {
            ts = ts.map { timeShift(mu: mu, tVal: $0) }
        }
        let tsDbl = ts.map { Double($0) }
        self.timesteps = MLXArray(converting: tsDbl, [ts.count]).asType(.float32)
    }

    /// _time_shift: exp(mu)/(exp(mu) + (1/t - 1)) for t>0, else 0.
    private func timeShift(mu: Float, tVal: Float) -> Float {
        if tVal <= 0 { return 0 }
        return Float(exp(Double(mu))) / (Float(exp(Double(mu))) + (1 / tVal - 1))
    }

    /// Euler step: prev = sample + dt * model_output (dt = t_prev - t_curr).
    public func step(modelOutput: MLXArray, timestepIdx: Int, sample: MLXArray) -> MLXArray {
        guard let ts = timesteps else { fatalError("setTimesteps() before step()") }
        let tCurr = ts[timestepIdx]
        let tPrev = ts[timestepIdx + 1]
        let dt = tPrev - tCurr
        return sample + dt * modelOutput
    }

    /// calculate_shift: linear interp between (base_seq_len, base_shift) and
    /// (max_seq_len, max_shift) based on image_seq_len.
    public static func calculateShift(
        imageSeqLen: Int, baseSeqLen: Int = 256, maxSeqLen: Int = 4096,
        baseShift: Float = 0.5, maxShift: Float = 1.15
    ) -> Float {
        let m = (maxShift - baseShift) / Float(maxSeqLen - baseSeqLen)
        let intercept = baseShift - m * Float(baseSeqLen)
        return Float(imageSeqLen) * m + intercept
    }
}

/// create_coordinate_grid: builds (d0*d1*d2, 3) positions.
/// Port of app/pipeline.py:create_coordinate_grid.
public enum PositionGrid {
    public static func create(size: (Int, Int, Int), start: (Int, Int, Int)) -> MLXArray {
        let (d0, d1, d2) = size
        let (s0, s1, s2) = start
        let iAxis = MLXArray.arange(s0, s0 + d0)
        let jAxis = MLXArray.arange(s1, s1 + d1)
        let kAxis = MLXArray.arange(s2, s2 + d2)
        let gridI = MLX.broadcast(iAxis.expandedDimensions(axis: -1).expandedDimensions(axis: -1), to: [d0, d1, d2])
        let gridJ = MLX.broadcast(jAxis.expandedDimensions(axis: -2).expandedDimensions(axis: -1), to: [d0, d1, d2])
        let gridK = MLX.broadcast(kAxis.expandedDimensions(axis: -2).expandedDimensions(axis: -2), to: [d0, d1, d2])
        return MLX.stacked([gridI, gridJ, gridK], axis: -1).reshaped([-1, 3])
    }
}
