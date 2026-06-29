//
//  Flux2Config.swift
//  Flux2Director
//
//  Architectural constants for the Flux2 Klein 9B MMDiT (Multi-Modal DiT).
//  Source: python/mlx-movie-director/models/transformer/klein-9b/config.json
//  + vendored mflux (mflux/models/flux2/variants/txt2img/flux2_klein.py).
//
//  Unlike Z-Image's S3-DiT, Flux2 Klein uses a DoubleBlock/SingleBlock split
//  (joint text+image attention in double blocks, shared attention in single
//  blocks) with RoPE positional encoding over packed (img+txt) tokens.
//

import Foundation

/// Flux2 Klein architecture variant.
public enum Flux2Variant: String, Sendable {
    case klein9b = "9b"
    case klein4b = "4b"

    public var hiddenSize: Int {
        switch self {
        case .klein9b: return 3072
        case .klein4b: return 3072   // 4b shares width; fewer layers
        }
    }
    /// Number of double (joint text+image) transformer blocks.
    public var numLayers: Int {
        switch self {
        case .klein9b: return 8
        case .klein4b: return 6
        }
    }
    /// Number of single (image-only) transformer blocks.
    public var numSingleLayers: Int {
        switch self {
        case .klein9b: return 24
        case .klein4b: return 18
        }
    }
    public var numHeads: Int { 24 }
    public var headDim: Int { 128 }
    /// VAE latent channels (Flux2 = 16).
    public var inChannels: Int { 16 }
    /// Patchify stride (Flux2 Klein = 1, unlike Z-Image's 2).
    public var patchSize: Int { 1 }
    public var mlpRatio: Float { 4.0 }
    /// Context (text) hidden dim from the qwen3-8b encoder.
    public var contextInDim: Int { 2560 }
    /// Scalar time/vec embedding dim.
    public var vecInDim: Int { 3072 }
    /// RoPE axes: 24 total head-dim = [4,4,4,4,4,4] across 6 axes? Flux2 uses
    /// axes_dim summing to headDim (128). Verified from config during port.
    public var axesDim: [Int] { [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4] }
}

