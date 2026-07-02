//
//  QuantizedWeights.swift
//  LTXVideoDirector
//
//  The real LTX-2.3 transformer checkpoint stores Linear weights MLX-
//  quantized (int8, group_size=64 — confirmed by inspecting
//  transformer-distilled-1.1.safetensors directly: packed U32 weight +
//  bf16 `.scales`/`.biases` siblings, shapes consistent with bits=8,
//  group_size=64). None of the Attention/FeedForward/etc. components
//  ported so far do quantized matmul — they expect plain float weights.
//  This dequantizes on load instead of implementing quantized inference,
//  which is simpler and fine for smoke-testing a handful of blocks (a
//  full 48-block dequantized-to-float dump would be far too large to
//  keep resident — see PLAN.md's real-checkpoint smoke test scope).
//

import MLX

public enum QuantizedWeights {
    /// Dequantize every `*.weight` key that has sibling `.scales`/`.biases`
    /// entries (the quantized-Linear convention); passes through any other
    /// key (norm weights, raw tables, plain biases) unchanged. Optionally
    /// restricts to keys under `keyPrefixes` to avoid dequantizing (and
    /// holding in memory) more of a large checkpoint than needed.
    public static func dequantizeLinearWeights(
        _ raw: [String: MLXArray], groupSize: Int = 64, bits: Int = 8,
        keyPrefixes: [String]? = nil
    ) -> [String: MLXArray] {
        var result: [String: MLXArray] = [:]
        for (key, value) in raw {
            if let keyPrefixes, !keyPrefixes.contains(where: { key.hasPrefix($0) }) {
                continue
            }
            if key.hasSuffix(".scales") || key.hasSuffix(".biases") {
                continue  // consumed alongside the matching .weight key
            }
            if key.hasSuffix(".weight") {
                let base = String(key.dropLast(".weight".count))
                if let scales = raw["\(base).scales"] {
                    let biases = raw["\(base).biases"]
                    result[key] = MLX.dequantized(value, scales: scales, biases: biases, groupSize: groupSize, bits: bits, dtype: .float32)
                } else {
                    result[key] = value.asType(.float32)
                }
            } else {
                result[key] = value.asType(.float32)
            }
        }
        return result
    }
}
