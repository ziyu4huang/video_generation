//
//  Krea2Sampler.swift
//  Krea2ImageDirector
//
//  Native Swift port of python/mlx-movie-director/scripts/krea2_smoke.py
//  sampler: flow-matching Euler with logit time-shift (Turbo: mu=1.15, cfg=0).
//

import Foundation
import MLX

public enum Krea2Sampler {
    /// Flow-matching timestep schedule (t: 1 -> 0) with logit-shift.
    public static func timesteps(seqLen: Int, steps: Int, mu: Double, sigma: Double = 1.0) -> [Float] {
        let emu = Foundation.exp(mu)
        var ts: [Float] = []
        for i in 0...steps {
            let lin = Float(steps - i) / Float(steps)   // linspace(1, 0, steps+1)
            let shifted = emu / (emu + Foundation.pow(1.0 / Double(lin) - 1.0, sigma))
            ts.append(Float(shifted))
        }
        return ts
    }

    /// Patchify latent + build pos/mask. Mirrors python sampling.prepare.
    /// noise: (B, 16, Hl, Wl). Returns (imgTokens, pos, mask).
    public static func prepare(noise: MLXArray, txtlen: Int, patch: Int, txtmask: MLXArray)
        -> (MLXArray, MLXArray, MLXArray) {
        let (B, C, Hl, Wl) = (noise.dim(0), noise.dim(1), noise.dim(2), noise.dim(3))
        let (Ht, Wt) = (Hl / patch, Wl / patch)
        // img pos: (Ht*Wt, 3) with h,w
        var posArr = [Float](repeating: 0, count: Ht * Wt * 3)
        for h in 0..<Ht { for w in 0..<Wt { posArr[(h * Wt + w) * 3 + 1] = Float(h); posArr[(h * Wt + w) * 3 + 2] = Float(w) } }
        let imgpos = MLXArray(posArr).reshaped([1, Ht * Wt, 3])
        let imgposB = MLX.broadcast(imgpos, to: [B, Ht * Wt, 3])
        let imgmask = MLX.ones([B, Ht * Wt], dtype: .bool)
        // patchify: (B,C,Hl,Wl) -> (B, Ht*Wt, C*patch*patch)
        var img = noise.reshaped([B, C, Ht, patch, Wt, patch])
        img = img.transposed(0, 2, 4, 1, 3, 5).reshaped([B, Ht * Wt, C * patch * patch])
        let txtpos = MLX.zeros([B, txtlen, 3])
        let mask = MLX.concatenated([txtmask, imgmask], axis: 1)
        let pos = MLX.concatenated([txtpos, imgposB], axis: 1)
        return (img, pos, mask)
    }
}
