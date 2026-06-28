//
//  TransformerConfig.swift
//  ZImageDirector
//
//  Mirrors `models/transformer/<variant>/config.json` (ZImageTransformer2DModel).
//

import Foundation

/// Strongly-typed `config.json` for a Z-Image transformer variant.
public struct TransformerConfig: Decodable, Sendable {
    public let dim: Int
    public let nheads: Int
    public let nLayers: Int
    public let nRefinerLayers: Int
    public let inChannels: Int
    public let axesDims: [Int]
    public let axesLens: [Int]
    public let ropeTheta: Double
    public let tScale: Double
    public let normEps: Float
    public let qkNorm: Bool
    /// `cap_feat_dim` — text-caption feature dimensionality (2560 for Z-Image).
    public let capFeatDim: Int
    /// Quantization bits (detected from manifest.json: 8 for mlx-8bit, 4 for mlx-4bit*).
    public var quantBits: Int
    /// Quantization group size (detected from manifest.json: 64 for 8-bit, 32 for 4-bit).
    public var quantGroupSize: Int

    // Coding keys matching the JSON keys in config.json.
    enum CodingKeys: String, CodingKey {
        case dim
        case nheads
        case nLayers = "n_layers"
        case nRefinerLayers = "n_refiner_layers"
        case inChannels = "in_channels"
        case axesDims = "axes_dims"
        case axesLens = "axes_lens"
        case ropeTheta = "rope_theta"
        case tScale = "t_scale"
        case normEps = "norm_eps"
        case qkNorm = "qk_norm"
        case capFeatDim = "cap_feat_dim"
    }

    /// Memberwise init (quant fields default to 8/64 — overridden by manifest detection).
    public init(dim: Int, nheads: Int, nLayers: Int, nRefinerLayers: Int, inChannels: Int,
                axesDims: [Int], axesLens: [Int], ropeTheta: Double, tScale: Double,
                normEps: Float, qkNorm: Bool, capFeatDim: Int,
                quantBits: Int = 8, quantGroupSize: Int = 64) {
        self.dim = dim; self.nheads = nheads; self.nLayers = nLayers
        self.nRefinerLayers = nRefinerLayers; self.inChannels = inChannels
        self.axesDims = axesDims; self.axesLens = axesLens
        self.ropeTheta = ropeTheta; self.tScale = tScale
        self.normEps = normEps; self.qkNorm = qkNorm; self.capFeatDim = capFeatDim
        self.quantBits = quantBits; self.quantGroupSize = quantGroupSize
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            dim: try container.decode(Int.self, forKey: .dim),
            nheads: try container.decode(Int.self, forKey: .nheads),
            nLayers: try container.decode(Int.self, forKey: .nLayers),
            nRefinerLayers: try container.decode(Int.self, forKey: .nRefinerLayers),
            inChannels: try container.decode(Int.self, forKey: .inChannels),
            axesDims: try container.decode([Int].self, forKey: .axesDims),
            axesLens: try container.decode([Int].self, forKey: .axesLens),
            ropeTheta: try container.decode(Double.self, forKey: .ropeTheta),
            tScale: try container.decode(Double.self, forKey: .tScale),
            normEps: try container.decode(Float.self, forKey: .normEps),
            qkNorm: try container.decode(Bool.self, forKey: .qkNorm),
            capFeatDim: try container.decode(Int.self, forKey: .capFeatDim)
        )
    }

    /// Load `config.json` from a transformer variant directory, and detect
    /// quantization bits/groupSize from the sibling `manifest.json`.
    public static func load(from dir: URL) throws -> TransformerConfig {
        let file = dir.appendingPathComponent("config.json")
        let data = try Data(contentsOf: file)
        let decoder = JSONDecoder()
        // First decode without quant fields, then fill from manifest.
        var cfg = try decoder.decode(TransformerConfig.self, from: data)
        let (bits, groupSize) = detectQuantization(from: dir)
        cfg.quantBits = bits
        cfg.quantGroupSize = groupSize
        return cfg
    }

    /// Detect quantization from manifest.json (mirrors Python _detect_transformer_quant).
    /// Returns (8, 64) for mlx-8bit, (4, 32) for mlx-4bit-gs32/mlx-4bit, default (4, 32).
    public static func detectQuantization(from dir: URL) -> (bits: Int, groupSize: Int) {
        let manifestURL = dir.appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: manifestURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let format = json["format"] as? String else {
            return (4, 32)  // backward-compatible default
        }
        switch format {
        case "mlx-8bit": return (8, 64)
        case "mlx-4bit-gs32", "mlx-4bit": return (4, 32)
        default: return (4, 32)
        }
    }

    /// Default config for the `moody-pro-mix` variant (dim=3840, 30+2 layers).
    public static let moodyProMix = TransformerConfig(
        dim: 3840, nheads: 30, nLayers: 30, nRefinerLayers: 2, inChannels: 16,
        axesDims: [32, 48, 48], axesLens: [1536, 512, 512],
        ropeTheta: 256.0, tScale: 1000.0, normEps: 1e-5, qkNorm: true,
        capFeatDim: 2560, quantBits: 8, quantGroupSize: 64
    )
}
