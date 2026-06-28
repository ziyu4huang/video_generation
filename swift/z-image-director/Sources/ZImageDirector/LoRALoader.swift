//
//  LoRALoader.swift
//  ZImageDirector
//
//  LoRA weight baking: merges LoRA (lora_A/lora_B) deltas directly into the
//  quantized base transformer weights (dequant → add → requant).
//
//  This mirrors the Python apply_lora() approach but bakes the delta into the
//  weights (inference-only, no training) rather than keeping a runtime side
//  branch — equivalent math, zero per-step overhead.
//
//  LoRA files are int8-quantized: lora_A.weight + lora_A.weight.scale (scalar).
//  Standard z-image LoRAs: rank=32, no alpha key, scale = user_scale.
//

import Foundation
import MLX
import MLXNN

public struct LoRAInfo {
    public let name: String
    public let path: String
    public let appliedLayers: Int
    public let totalLayers: Int
    public let userScale: Float
    public let rank: Int
}

public enum LoRALoader {

    /// Apply a LoRA adapter to the base weights dict (in place).
    ///
    /// - Parameters:
    ///   - weights: the mutable transformer weight dict (modified in place).
    ///   - config: transformer config (for bits/groupSize).
    ///   - loraPath: path to the .safetensors LoRA file.
    ///   - userScale: LoRA strength multiplier (default 1.0).
    /// - Returns: info about what was applied.
    @discardableResult
    public static func apply(
        to weights: inout [String: MLXArray],
        config: TransformerConfig,
        loraPath: String,
        userScale: Float = 1.0
    ) throws -> LoRAInfo {
        let name = (loraPath as NSString).lastPathComponent
        let loraURL = URL(fileURLWithPath: loraPath)
        let loraTensors = try loadArrays(url: URL(fileURLWithPath: loraPath))

        // First pass: identify lora_A/lora_B pairs and their scale keys.
        // Group by base key (strip .lora_A.weight / .lora_B.weight).
        var pairs: [(baseKey: String, aKey: String, bKey: String)] = []
        var scaleKeys = Set<String>()
        for key in loraTensors.keys {
            if key.hasSuffix(".scale") {
                scaleKeys.insert(key)
            }
        }
        for key in loraTensors.keys where key.contains("lora_A") && !key.hasSuffix(".scale") {
            let baseKey = key.components(separatedBy: ".lora_A").first ?? key
            let bKey = baseKey + ".lora_B.weight"
            if loraTensors[bKey] != nil {
                pairs.append((baseKey, key, bKey))
            }
        }

        let gs = config.quantGroupSize
        let bits = config.quantBits
        var applied = 0

        for pair in pairs {
            // Dequantize LoRA tensors (int8 × scale → float32).
            let loraA = dequantizeLoRATensor(loraTensors[pair.aKey]!, scaleKey: pair.aKey, tensors: loraTensors, scaleKeys: scaleKeys)
            let loraB = dequantizeLoRATensor(loraTensors[pair.bKey]!, scaleKey: pair.bKey, tensors: loraTensors, scaleKeys: scaleKeys)

            // Convert LoRA source key → MLX model key.
            let mlxKey = convertLoRAKeyToMLX(pair.baseKey)

            // delta = loraB @ loraA * userScale  (shape: [out, in])
            // loraA: [rank, in], loraB: [out, rank] → delta: [out, in]
            var delta = loraB.matmul(loraA) * userScale

            // Bake into the base weight. Base weights are quantized:
            // {key.weight, key.scales, key.biases}.
            let wKey = mlxKey + ".weight"
            let sKey = mlxKey + ".scales"
            let bKey = mlxKey + ".biases"

            guard let baseW = weights[wKey],
                  let baseS = weights[sKey],
                  let baseB = weights[bKey] else {
                continue
            }

            // Dequantize base.
            var baseDeq = dequantized(baseW, scales: baseS, biases: baseB,
                                      groupSize: gs, bits: bits, mode: .affine)

            // Shape alignment: base is [out, in_packed] after dequant → [out, in].
            // delta is [out, in]. If shapes mismatch, transpose delta.
            if baseDeq.shape != delta.shape {
                delta = delta.T
            }
            if baseDeq.shape != delta.shape {
                continue  // still mismatched — skip this layer
            }

            // Add delta (in float32) and re-quantize.
            baseDeq = (baseDeq.asType(.float32) + delta.asType(.float32))
            MLX.eval(baseDeq)
            let (newW, newS, newB) = MLX.quantized(baseDeq, groupSize: gs, bits: bits, mode: .affine)
            MLX.eval(newW, newS, newB)

            weights[wKey] = newW
            weights[sKey] = newS
            weights[bKey] = newB
            applied += 1
        }

        let rank = pairs.first.flatMap { loraTensors[$0.aKey]?.shape.first } ?? 0
        return LoRAInfo(
            name: name, path: loraPath, appliedLayers: applied,
            totalLayers: pairs.count, userScale: userScale, rank: rank
        )
    }

    /// Dequantize an int8 LoRA tensor (value × scalar scale), or pass through float tensors.
    private static func dequantizeLoRATensor(
        _ tensor: MLXArray, scaleKey: String,
        tensors: [String: MLXArray], scaleKeys: Set<String>
    ) -> MLXArray {
        // The scale key is "<aKey>.scale" (companion to lora_A.weight).
        let companionScaleKey = scaleKey + ".scale"
        if scaleKeys.contains(companionScaleKey), let scaleVal = tensors[companionScaleKey] {
            // int8 value × scalar scale → float32
            let scale = scaleVal.item(Float.self)
            return (tensor.asType(.float32) * scale).asType(.float32)
        }
        // Standard float LoRA (not int8).
        return tensor.asType(.float32)
    }

    /// Convert a LoRA source key to the MLX model key.
    /// e.g. "diffusion_model.layers.0.attention.to_q" → "layers.0.attention.to_q"
    public static func convertLoRAKeyToMLX(_ key: String) -> String {
        var mapped = key
        mapped = mapped.replacingOccurrences(of: "diffusion_model.", with: "")
        mapped = mapped.replacingOccurrences(of: "attention_to_q", with: "attention.to_q")
        mapped = mapped.replacingOccurrences(of: "attention_to_k", with: "attention.to_k")
        mapped = mapped.replacingOccurrences(of: "attention_to_v", with: "attention.to_v")
        mapped = mapped.replacingOccurrences(of: "attention_to_out_0", with: "attention.to_out")
        mapped = mapped.replacingOccurrences(of: "feed_forward_w1", with: "feed_forward.w1")
        mapped = mapped.replacingOccurrences(of: "feed_forward_w2", with: "feed_forward.w2")
        mapped = mapped.replacingOccurrences(of: "feed_forward_w3", with: "feed_forward.w3")
        // layers_N_ → layers.N.
        if let range = mapped.range(of: #"layers_(\d+)_"#, options: .regularExpression) {
            let matched = String(mapped[range])
            let digitPart = matched.replacingOccurrences(of: "layers_", with: "")
                .replacingOccurrences(of: "_", with: "")
            mapped = mapped.replacingCharacters(in: range, with: "layers.\(digitPart).")
        }
        return mapped
    }
}
