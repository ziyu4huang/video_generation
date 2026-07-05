//
//  Flux2KVStyleTransfer.swift
//  Flux2Director
//
//  Training-free K/V-injection style transfer for Flux2 Klein — the mechanism
//  ported from the validated krea2 director (V-AdaIN + per-frequency K-scale +
//  Q/K cross-batch AdaIN + strength mix-blend), adapted to Flux2's transformer.
//
//  GATE (non-negotiable): flux2 style strength=0 is BYTE-IDENTICAL to vanilla
//  flux2 t2i at the same seed. Held by construction two ways:
//    (1) ROUTING — Flux2ParallelSelfAttention takes an optional `style`; when the
//        effective strength is 0 (or style is nil) it calls the ORIGINAL SDPA path
//        (F2AttentionOps.compute) verbatim, never reaching the styled code.
//    (2) BATCH-INVARIANCE — even with the 2-B [target;ref] batch, flux2's SDPA /
//        LayerNorm / RoPE / linears are all per-batch-element (the only cross-batch
//        op, BN, uses fixed inference stats in the latent creator, not here), so
//        slicing the target row of a vanilla 2-B forward == a 1-B vanilla forward.
//  krea2's strength=0 identity, by contrast, relies on krea2 VANILLA also using
//  manual attention; flux2 vanilla uses SDPA and SDPA≠manual on this hardware
//  (Krea2DiT.swift:7), so the routing early-out is mandatory here, not optional.
//

import Foundation
import MLX

// MARK: - Style config + defaults

/// Per-frequency K-scale endpoint rescaling by strength (krea2 nodes.py:1987-1989,
/// identical formula — ported so flux2 matches the validated behavior). Identity at
/// strength=1.0; collapses to 1 at strength=0 (moot under routing, but correct).
public struct Flux2ScaleEndpoints {
    public static func effective(highStart: Float, lowEnd: Float, strength: Float) -> (Float, Float) {
        let effHigh = 1 + (highStart - 1) * Swift.min(strength, 1.5)
        let effLow = 1 + (lowEnd - 1) * strength
        return (effHigh, effLow)
    }
}

/// Knobs mirroring Krea2StyleDefaults (ComfyUI-Krea2-StyleTransfer _RECOMMENDED).
public struct Flux2StyleDefaults {
    public var valueAdainStrength: Float
    public var refValueMix: Float
    public var refKStrength: Float
    public var beta: Float
    public var highScaleStart: Float
    public var highScaleEnd: Float
    public var lowScaleStart: Float
    public var lowScaleEnd: Float
    public var adainStrength: Float
    public var activeBlocks: ClosedRange<Int>

    public init(valueAdainStrength: Float = 0.65, refValueMix: Float = 1.0,
                refKStrength: Float = 1.06, beta: Float = 2.5,
                highScaleStart: Float = 1.04, highScaleEnd: Float = 0.0,
                lowScaleStart: Float = 1.0, lowScaleEnd: Float = 1.10,
                adainStrength: Float = 0.85,
                activeBlocks: ClosedRange<Int> = 7...27) {
        self.valueAdainStrength = valueAdainStrength
        self.refValueMix = refValueMix
        self.refKStrength = refKStrength
        self.beta = beta
        self.highScaleStart = highScaleStart; self.highScaleEnd = highScaleEnd
        self.lowScaleStart = lowScaleStart; self.lowScaleEnd = lowScaleEnd
        self.adainStrength = adainStrength
        self.activeBlocks = activeBlocks
    }
}

/// Resolved per-step style config. `mix`/`effAdain` are pre-resolved from strength
/// so the attention never re-derives them. `targetB` = number of target batch rows
/// (1 for single-image style transfer); ref occupies rows [targetB..<B].
public struct Flux2StyleConfig {
    public let targetB: Int
    public let imgS: Int          // image-token start (txtLen in the [text;image] layout)
    public let imgE: Int          // image-token end (exclusive)
    public let scaleVec: MLXArray // (headDim,) per-frequency K scale
    public let refKStrength: Float
    public let valueAdainStrength: Float
    public let refValueMix: Float
    public let adainStrength: Float
    public let mix: Float         // strength-blend (0 → styled contribution discarded)

    public init(targetB: Int, imgS: Int, imgE: Int, scaleVec: MLXArray,
                refKStrength: Float, valueAdainStrength: Float, refValueMix: Float,
                adainStrength: Float, mix: Float) {
        self.targetB = targetB; self.imgS = imgS; self.imgE = imgE
        self.scaleVec = scaleVec; self.refKStrength = refKStrength
        self.valueAdainStrength = valueAdainStrength; self.refValueMix = refValueMix
        self.adainStrength = adainStrength; self.mix = mix
    }
}

// MARK: - scale-vec builder (ported from krea2)

/// Per-frequency K scale over headDim. Same construction as krea2's styleScaleVec:
/// axes = [hd-12*(hd/16), 6*(hd/16), 6*(hd/16)]; axis-0 flat = low_scale; axes ≥1:
/// scale = high + (low-high)·linspace^beta.
public func flux2StyleScaleVec(progress: Float, beta: Float,
                               highStart: Float, highEnd: Float,
                               lowStart: Float, lowEnd: Float,
                               headDim: Int) -> MLXArray {
    let h = headDim / 16
    let axes = [headDim - 12 * h, 6 * h, 6 * h]
    let high = highStart + (highEnd - highStart) * progress
    let low = lowStart + (lowEnd - lowStart) * progress
    var vec: [Float] = []
    for (ai, dim) in axes.enumerated() {
        let pairs = dim / 2
        for j in 0..<pairs {
            let t = pairs > 1 ? Float(j) / Float(pairs - 1) : 0
            let s = ai == 0 ? low : (high + (low - high) * Foundation.pow(t, beta))
            vec.append(s); vec.append(s)
        }
    }
    return MLXArray(vec)
}

// MARK: - styled attention (ported from Krea2DiT.styledAttention, image range = imgS..<imgE)

public enum F2StyleOps {
    /// Styled single-block attention: target attends to its own (Q/K-AdaIN'd) K/V
    /// PLUS the ref's per-frequency-scaled K + AdaIN-mixed V, blended by `mix`.
    /// q/k/v: (B, H, S, D); st.targetB = tb; ref = rows [tb..<B]; image range = imgS..<imgE.
    /// Returns (B, S, H*D) — same layout as F2AttentionOps.compute's caller expects.
    public static func styledAttention(q: MLXArray, k: MLXArray, v: MLXArray, scale: Float,
                                       st: Flux2StyleConfig) -> MLXArray {
        let (B, H, L, D) = (q.dim(0), q.dim(1), q.dim(2), q.dim(3))
        let tb = st.targetB
        let ir = st.imgS..<st.imgE
        let qT0 = q[0..<tb], qR = q[tb..<B]
        let kT0 = k[0..<tb], kR = k[tb..<B]
        let vT0 = v[0..<tb], vR = v[tb..<B]
        let eps = MLXArray(1e-6)

        // Q/K cross-batch AdaIN (alpha = st.adainStrength), image tokens only.
        let qT: MLXArray, kT: MLXArray
        if st.adainStrength > 0 {
            qT = blendAdaIN(qT0, qR, ir: ir, alpha: st.adainStrength, eps: eps)
            kT = blendAdaIN(kT0, kR, ir: ir, alpha: st.adainStrength, eps: eps)
        } else {
            qT = qT0; kT = kT0
        }

        // Per-frequency scaled ref K (image tokens) × refKStrength.
        let scaleVec = st.scaleVec.expandedDimensions(axis: 0).expandedDimensions(axis: 0).expandedDimensions(axis: 0)
        let refK = kR[0..., 0..., ir, 0...] * scaleVec * st.refKStrength
        let refV = vR[0..., 0..., ir, 0...]
        let tgtV = vT0[0..., 0..., ir, 0...]

        // V AdaIN over image tokens (ref stats → target), then value-mix blend.
        let muT = tgtV.mean(axis: 2, keepDims: true)
        let sdT = MLX.sqrt(tgtV.variance(axis: 2, keepDims: true) + eps)
        let muR = refV.mean(axis: 2, keepDims: true)
        let sdR = MLX.sqrt(refV.variance(axis: 2, keepDims: true) + eps)
        let adaV = (tgtV - muT) / sdT * sdR + muR
        let baseV = tgtV * (1 - st.valueAdainStrength) + adaV * st.valueAdainStrength
        let injV = baseV * (1 - st.refValueMix) + refV * st.refValueMix

        // Target attends to its own K/V PLUS the ref K/V.
        let kTarget = MLX.concatenated([kT, refK], axis: 2)
        let vTarget = MLX.concatenated([vT0, injV], axis: 2)
        let nativeScores = MLX.matmul(qT, kT.transposed(0, 1, 3, 2)) * scale
        let nativeOut = MLX.matmul(MLX.softmax(nativeScores, axis: -1), vT0)
        let styledScores = MLX.matmul(qT, kTarget.transposed(0, 1, 3, 2)) * scale
        let styledOut = MLX.matmul(MLX.softmax(styledScores, axis: -1), vTarget)
        let outT = nativeOut * (1 - st.mix) + styledOut * st.mix

        // Ref batch: native self-attention, unchanged.
        let outR = MLX.matmul(MLX.softmax(MLX.matmul(qR, kR.transposed(0, 1, 3, 2)) * scale, axis: -1), vR)
        let both = MLX.concatenated([outT, outR], axis: 0) // (B, H, L, D)
        return both.transposed(0, 2, 1, 3).reshaped([B, L, H * D])
    }

    /// AdaIN blend of target's image-token slice toward ref's stats: out ir-slice
    /// = tgt·(1-α) + AdaIN(tgt,ref)·α; non-image tokens unchanged.
    private static func blendAdaIN(_ tgt: MLXArray, _ ref: MLXArray, ir: Range<Int>,
                                   alpha: Float, eps: MLXArray) -> MLXArray {
        let t = tgt[0..., 0..., ir, 0...]
        let r = ref[0..., 0..., ir, 0...]
        let muT = t.mean(axis: 2, keepDims: true)
        let sdT = MLX.sqrt(t.variance(axis: 2, keepDims: true) + eps)
        let muR = r.mean(axis: 2, keepDims: true)
        let sdR = MLX.sqrt(r.variance(axis: 2, keepDims: true) + eps)
        let adained = (t - muT) / sdT * sdR + muR
        let blended = t * (1 - alpha) + adained * alpha
        // Reassemble: non-ir slices from tgt, ir slice from blended.
        let before = ir.lowerBound > 0 ? tgt[0..., 0..., 0..<ir.lowerBound, 0...] : nil
        let after = ir.upperBound < tgt.dim(2) ? tgt[0..., 0..., ir.upperBound..<tgt.dim(2), 0...] : nil
        var parts: [MLXArray] = []
        if let before { parts.append(before) }
        parts.append(blended)
        if let after { parts.append(after) }
        return MLX.concatenated(parts, axis: 2)
    }
}
