//
//  Krea2Config.swift
//  Krea2ImageDirector
//
//  Krea 2 Turbo DiT configuration (SingleMMDiTConfig). Mirrors
//  python/mlx-movie-director/app/krea2_transformer.py Krea2DiTConfig defaults,
//  which mirror krea-ai/krea-2 inference.py single_mmdit_large_wide.
//
//  The full memberwise init lets parity tests build a SMALL config (so a
//  SingleStreamBlock forward runs on ~128-dim random weights instead of the
//  6144-dim real model). Production code uses `Krea2Config()`.
//

import Foundation

public struct Krea2Config: Sendable {
    public let features: Int
    public let tdim: Int
    public let txtdim: Int
    public let heads: Int
    public let kvheads: Int
    public let multiplier: Int
    public let layers: Int
    public let patch: Int
    public let channels: Int
    public let theta: Double          // RoPE theta (NOT 1e4)
    public let txtlayers: Int
    public let txtheads: Int
    public let txtkvheads: Int

    /// Production defaults (Krea 2 Turbo single_mmdit_large_wide).
    public init() {
        self.init(features: 6144, tdim: 256, txtdim: 2560, heads: 48, kvheads: 12,
                  multiplier: 4, layers: 28, patch: 2, channels: 16, theta: 1e3,
                  txtlayers: 12, txtheads: 20, txtkvheads: 20)
    }

    /// Full memberwise init (parity tests pass a small config).
    public init(features: Int, tdim: Int, txtdim: Int, heads: Int, kvheads: Int,
                multiplier: Int, layers: Int, patch: Int, channels: Int, theta: Double,
                txtlayers: Int, txtheads: Int, txtkvheads: Int) {
        self.features = features
        self.tdim = tdim
        self.txtdim = txtdim
        self.heads = heads
        self.kvheads = kvheads
        self.multiplier = multiplier
        self.layers = layers
        self.patch = patch
        self.channels = channels
        self.theta = theta
        self.txtlayers = txtlayers
        self.txtheads = txtheads
        self.txtkvheads = txtkvheads
    }

    /// RoPE axes: [headdim - 12*(headdim//16), 6*(headdim//16), 6*(headdim//16)]
    /// = [32, 48, 48] for headdim=128. Sums to headdim, all even.
    public var headDim: Int { features / heads }
    public var ropeAxes: [Int] {
        let h = headDim / 16
        return [headDim - 12 * h, 6 * h, 6 * h]
    }

    /// Turbo sampler defaults (CFG-free, mu=1.15).
    public let defaultSteps = 8
    public let defaultMu = 1.15
    public let defaultCfg = 0.0
}
