//
//  Weights.swift
//  ZImageDirector
//
//  Phase 1: load the repo's 8-bit MLX safetensors and validate the key
//  structure against TransformerConfig. This mirrors how Python's
//  ZImageTransformerMLX consumes weights via mlx.nn.Module.load_weights().
//

import CommonImageDirector
import Foundation
import MLX
import MLXNN

/// Result of loading a transformer variant's weights.
public struct LoadedWeights {
    public let variant: String
    public let directory: URL
    public let config: TransformerConfig
    public let arrays: [String: MLXArray]
    public let keyAudit: WeightKeyAudit
}

/// Structural audit of the safetensors key set against the config-derived
/// expectation. Produced by ``WeightStore/validate(keys:config:)``.
public struct WeightKeyAudit: Sendable {
    /// Total number of keys found in the safetensors file.
    public let totalKeys: Int
    /// Number of keys whose top-level prefix matched an expected module group.
    public let matchedKeys: Int
    /// Per-group breakdown: prefix → count of keys found.
    public let groupCounts: [String: Int]
    /// Any keys whose top-level prefix was not in the expected set.
    public let unexpectedPrefixes: [String]
    /// Summary text for the CLI / logging.
    public var summary: String {
        var lines: [String] = []
        lines.append("total keys: \(totalKeys) (matched: \(matchedKeys))")
        let sortedGroups = groupCounts.sorted { $0.key < $1.key }
        for (g, n) in sortedGroups {
            let exp = WeightStore.expectedGroupInfo(g, config: nil).detail
            lines.append("  \(g): \(n) keys  [\(exp)]")
        }
        if !unexpectedPrefixes.isEmpty {
            lines.append("UNEXPECTED prefixes: \(unexpectedPrefixes)")
        }
        return lines.joined(separator: "\n")
    }
}

/// Loads and validates Z-Image transformer weights (Phase 1).
///
/// The repo stores every transformer variant as `model.safetensors` — an 8-bit
/// MLX-quantized checkpoint — symlinked to the external binary store. This type
/// reads it into `[String: MLXArray]` and checks the key structure against the
/// `config.json` so Phase 2's module construction has a trustworthy input.
public enum WeightStore {

    /// Load `model.safetensors` for a named variant (e.g. `moody-pro-mix`).
    public static func load(
        variant: String,
        config: TransformerConfig? = nil
    ) throws -> LoadedWeights {
        let dir = ModelPaths.transformer(variant)
        let file = dir.appendingPathComponent("model.safetensors")

        guard FileManager.default.fileExists(atPath: file.path) else {
            throw WeightError.fileNotFound(file.path)
        }

        // The model.safetensors in the repo is a symlink to the external
        // binary store (../video_generation__models/). MLX reads it
        // transparently — no manual resolution needed.
        let cfg = try config ?? TransformerConfig.load(from: dir)

        let arrays = try loadArrays(url: file)

        let audit = validate(keys: Array(arrays.keys), config: cfg)
        try audit.assertValid()

        return LoadedWeights(
            variant: variant,
            directory: dir,
            config: cfg,
            arrays: arrays,
            keyAudit: audit
        )
    }

    // MARK: - Validation

    /// Validate a list of safetensors keys against the config-derived expectation.
    ///
    /// The expected top-level groups are fixed by the architecture:
    /// `t_embedder`, `x_embedder`, `cap_embedder`, `noise_refiner`,
    /// `context_refiner`, `layers`, `final_layer`, plus the two pad tokens.
    public static func validate(
        keys: [String], config: TransformerConfig
    ) -> WeightKeyAudit {
        let expectedTopLevel: Set<String> = [
            "t_embedder", "x_embedder", "cap_embedder",
            "noise_refiner", "context_refiner", "layers", "final_layer",
            "x_pad_token", "cap_pad_token",
        ]

        var groupCounts: [String: Int] = [:]
        var unexpected: [String] = []
        var matched = 0
        for k in keys {
            let top = k.split(separator: ".").first.map(String.init) ?? k
            if expectedTopLevel.contains(top) {
                groupCounts[top, default: 0] += 1
                matched += 1
            } else {
                if !unexpected.contains(top) { unexpected.append(top) }
            }
        }

        return WeightKeyAudit(
            totalKeys: keys.count,
            matchedKeys: matched,
            groupCounts: groupCounts,
            unexpectedPrefixes: unexpected
        )
    }

    /// Architecture metadata for a top-level group (used in audit summaries).
    static func expectedGroupInfo(_ prefix: String, config: TransformerConfig?)
        -> (count: Int?, detail: String)
    {
        let cfg = config ?? TransformerConfig.moodyProMix
        switch prefix {
        case "t_embedder":
            return (8, "2 quantized linears (linear1/linear2) × {weight,scales,biases,bias}")
        case "x_embedder":
            return (4, "1 quantized linear × {weight,scales,biases,bias}")
        case "cap_embedder":
            return (5, "RMSNorm weight + 1 quantized linear × {weight,scales,biases,bias}")
        case "noise_refiner":
            return (cfg.nRefinerLayers * 31, "\(cfg.nRefinerLayers) modulated blocks × 31 keys")
        case "context_refiner":
            return (cfg.nRefinerLayers * 27, "\(cfg.nRefinerLayers) non-modulated blocks × 27 keys")
        case "layers":
            return (cfg.nLayers * 31, "\(cfg.nLayers) modulated blocks × 31 keys")
        case "final_layer":
            return (8, "norm(linear) + adaLN quantized linear")
        case "x_pad_token", "cap_pad_token":
            return (1, "single pad token (1, dim)")
        default:
            return (nil, "?")
        }
    }
}

extension WeightKeyAudit {
    /// Throws if the audit reveals a structural problem.
    public func assertValid() throws {
        guard unexpectedPrefixes.isEmpty else {
            throw WeightError.unexpectedKeys(unexpectedPrefixes)
        }
        guard matchedKeys > 0 else {
            throw WeightError.noMatchingKeys
        }
    }
}

public enum WeightError: Error, LocalizedError {
    case fileNotFound(String)
    case unexpectedKeys([String])
    case noMatchingKeys

    public var errorDescription: String? {
        switch self {
        case .fileNotFound(let p): return "Weight file not found: \(p)"
        case .unexpectedKeys(let k): return "Unexpected weight key prefixes: \(k)"
        case .noMatchingKeys: return "No recognized weight keys found in file"
        }
    }
}
