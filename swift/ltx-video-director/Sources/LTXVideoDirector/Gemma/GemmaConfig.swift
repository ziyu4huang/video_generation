//
//  GemmaConfig.swift
//  LTXVideoDirector
//
//  Config for the Gemma-3-12b text encoder (gemma3_text), the sole remaining
//  non-native piece of the distilled I2V pipeline. Values read directly from
//  mlx-community/gemma-3-12b-it-4bit/config.json + mlx-lm's gemma3_text.py
//  ModelArgs defaults (the checkpoint's text_config is sparse — most fields
//  use the dataclass defaults). See PLAN.md's Gemma section.
//

import Foundation

public struct GemmaConfig {
    public var hiddenSize = 3840
    public var numHiddenLayers = 48
    public var intermediateSize = 15360
    public var numAttentionHeads = 16
    public var headDim = 256
    public var numKeyValueHeads = 8
    public var rmsNormEps: Float = 1e-6
    public var vocabSize = 262144
    /// rope_theta for GLOBAL attention layers (every sliding_window_pattern-th).
    public var ropeTheta: Float = 1_000_000
    /// rope base for SLIDING attention layers.
    public var ropeLocalBaseFreq: Float = 10_000
    /// Attention scale = query_pre_attn_scalar ** -0.5 (NOT head_dim**-0.5).
    public var queryPreAttnScalar: Float = 256
    public var slidingWindow = 1024
    /// Layer N is global iff N % pattern == pattern-1. So for pattern=6,
    /// layers 5,11,17,... are global; the rest are sliding.
    public var slidingWindowPattern = 6
    public var maxPositionEmbeddings = 32768
    /// Linear RoPE scaling (factor 8) applied to GLOBAL layers only.
    public var ropeScalingFactor: Float = 8.0

    /// True iff this layer index uses sliding-window (local) RoPE.
    /// Mirrors mlx-lm gemma3_text.Attention: `is_sliding = (layer_idx+1) % pattern != 0`.
    public func isSliding(layerIdx: Int) -> Bool {
        (layerIdx + 1) % slidingWindowPattern != 0
    }

    public init() {}
}
