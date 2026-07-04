//
//  LatentConditioning.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.conditioning.types.latent_cond — the I2V
//  conditioning mechanism: LatentState (generation state),
//  VideoConditionByLatentIndex (splices a conditioning image's clean latent
//  tokens into specific frame positions, e.g. frame 0 for I2V), and
//  applyDenoiseMask (blends a predicted x0 with the clean latent per the
//  mask, called after every denoise step).
//
//  NOT YET WIRED: per-token timesteps. The reference's denoise_loop
//  switches to per-token timestep embedding when the mask is non-uniform
//  so PRESERVED tokens get AdaLN modulation with timestep=0 (no
//  modulation at all) instead of the batch's shared sigma — X0Model/
//  LTXModel only support the scalar-timestep path so far (see their file
//  headers). Since applyDenoiseMask forces preserved tokens back to
//  clean_latent after every step regardless, generated-token output is
//  unaffected; preserved-token internal computation during the forward
//  pass is a documented approximation until per-token timesteps land.
//

import MLX

public struct LatentState {
    public var latent: MLXArray          // (B, N, C) noisy latent being denoised
    public var cleanLatent: MLXArray     // (B, N, C) original clean latent for conditioning
    public var denoiseMask: MLXArray     // (B, N, 1): 1.0 = generate, 0.0 = preserve
    public var positions: MLXArray?      // (B, N, numAxes)
    public var attentionMask: MLXArray?

    public init(latent: MLXArray, cleanLatent: MLXArray, denoiseMask: MLXArray, positions: MLXArray? = nil, attentionMask: MLXArray? = nil) {
        self.latent = latent
        self.cleanLatent = cleanLatent
        self.denoiseMask = denoiseMask
        self.positions = positions
        self.attentionMask = attentionMask
    }
}

/// Blend a predicted x0 with the clean latent using the denoise mask.
/// Where mask=1.0 (generate): use x0. Where mask=0.0 (preserve): use clean_latent.
public func applyDenoiseMask(x0: MLXArray, cleanLatent: MLXArray, denoiseMask: MLXArray) -> MLXArray {
    x0 * denoiseMask + cleanLatent * (1.0 - denoiseMask)
}

/// Splices a conditioning image/video's clean latent tokens into specific
/// frame positions (e.g. frame 0 for I2V), setting those tokens' denoise
/// mask so they're preserved (not regenerated) rather than denoised.
public struct VideoConditionByLatentIndex {
    public let frameIndices: [Int]
    public let cleanLatent: MLXArray  // (B, numIndices * tokensPerFrame, C)
    public let strength: Float        // 1.0 = fully preserved (mask=0), 0.0 = fully denoised (mask=1)

    public init(frameIndices: [Int], cleanLatent: MLXArray, strength: Float = 1.0) {
        self.frameIndices = frameIndices
        self.cleanLatent = cleanLatent
        self.strength = strength
    }

    /// `spatialDims` is (F, H, W) — only H*W (tokens per frame) is used.
    public func apply(to state: LatentState, spatialDims: (Int, Int, Int)) -> LatentState {
        let (_, h, w) = spatialDims
        let tokensPerFrame = h * w
        let maskValue = 1.0 - strength

        var newLatent = state.latent
        var newClean = state.cleanLatent
        var newMask = state.denoiseMask

        for (i, frameIdx) in frameIndices.enumerated() {
            let start = frameIdx * tokensPerFrame
            let end = start + tokensPerFrame
            let srcStart = i * tokensPerFrame
            let srcEnd = srcStart + tokensPerFrame

            if srcEnd > cleanLatent.dim(1) { break }

            let frameTokens = cleanLatent[0..., srcStart..<srcEnd, 0...]

            newLatent = MLX.concatenated([newLatent[0..., 0..<start, 0...], frameTokens, newLatent[0..., end..., 0...]], axis: 1)
            newClean = MLX.concatenated([newClean[0..., 0..<start, 0...], frameTokens, newClean[0..., end..., 0...]], axis: 1)
            let b = state.denoiseMask.dim(0)
            let frameMask = MLXArray(Array(repeating: maskValue, count: b * tokensPerFrame)).reshaped([b, tokensPerFrame, 1])
            newMask = MLX.concatenated([newMask[0..., 0..<start, 0...], frameMask, newMask[0..., end..., 0...]], axis: 1)
        }

        return LatentState(latent: newLatent, cleanLatent: newClean, denoiseMask: newMask, positions: state.positions, attentionMask: state.attentionMask)
    }
}

/// Native port of `ltx_core_mlx.conditioning.types.reference_video_cond
/// .VideoConditionByReferenceLatent` — IC-LoRA style reference conditioning.
/// Unlike `VideoConditionByLatentIndex` (which REPLACES tokens at fixed
/// positions, same sequence length), this APPENDS a whole reference clip's
/// clean latent tokens to the end of the sequence — used by
/// `NativeUpscaleStage`'s `hd` mode: the low-res/degraded input video is
/// VAE-encoded and appended as always-preserved (denoiseMask=0) context the
/// generation tokens can attend to via ordinary self-attention (no special
/// cross-attention path needed — this package's `Attention.swift`/
/// `DenoiseLoop.swift` already thread a per-state `attentionMask` end to
/// end for exactly this kind of masked joint sequence).
///
/// Scope: this port covers `strength == 1.0` (fully preserved reference,
/// `attn_mask == nil` in the reference — the common case; see
/// `ic_lora.py`'s `_create_conditionings`, which only builds a real
/// `attn_mask` for partial `conditioning_attention_strength`/an explicit
/// mask video, neither of which `NativeUpscaleStage.generateHD` uses).
/// Partial-strength/masked reference conditioning (`update_attention_mask`'s
/// general case) is not ported — no current call site needs it.
public struct VideoConditionByReferenceLatent {
    public let referenceLatent: MLXArray      // (B, Nr, C)
    public let referencePositions: MLXArray?  // (B, Nr, numAxes)
    public let downscaleFactor: Int           // target/reference resolution ratio; scales H/W positions only
    public let strength: Float                // 1.0 = fully preserved (mask=0)

    public init(referenceLatent: MLXArray, referencePositions: MLXArray? = nil, downscaleFactor: Int = 1, strength: Float = 1.0) {
        self.referenceLatent = referenceLatent
        self.referencePositions = referencePositions
        self.downscaleFactor = downscaleFactor
        self.strength = strength
    }

    public func apply(to state: LatentState) -> LatentState {
        let numRef = referenceLatent.dim(1)
        let maskValue = 1.0 - strength

        let newLatent = MLX.concatenated([state.latent, referenceLatent], axis: 1)
        let newClean = MLX.concatenated([state.cleanLatent, referenceLatent], axis: 1)

        let b = state.denoiseMask.dim(0)
        let refMask = MLXArray(Array(repeating: maskValue, count: b * numRef)).reshaped([b, numRef, 1])
        let newMask = MLX.concatenated([state.denoiseMask, refMask], axis: 1)

        var newPositions = state.positions
        if let statePositions = state.positions, let referencePositions {
            var refPos = referencePositions
            if downscaleFactor != 1 {
                // Scale spatial axes only (index 1 = height, index 2 = width), not temporal (index 0).
                let scale = MLXArray([Float(1.0), Float(downscaleFactor), Float(downscaleFactor)]).reshaped([1, 1, 3])
                refPos = refPos * scale
            }
            newPositions = MLX.concatenated([statePositions, refPos], axis: 1)
        }

        // attentionMask left as state.attentionMask (nil in the strength==1.0,
        // no-mask-video case this port covers) — see this type's header.
        return LatentState(latent: newLatent, cleanLatent: newClean, denoiseMask: newMask, positions: newPositions, attentionMask: state.attentionMask)
    }
}
