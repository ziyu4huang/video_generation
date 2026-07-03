//
//  LoRAFusion.swift
//  LTXVideoDirector
//
//  Ports the fusion math from `ltx_core_mlx.loader.fuse_loras.apply_loras`
//  (`_prepare_deltas`/`_fuse_delta_with_float`): for each weight key, sum
//  `strength_i * (B_i @ A_i)` across every LoRA that has a matching pair,
//  then add the result to the base weight.
//
//  One deliberate simplification vs. the vendor reference: `apply_loras`
//  re-quantizes the fused weight back to int4/int8 (`_fuse_delta_with_quantized`)
//  because the vendor keeps quantized weights resident for memory/speed.
//  This package's `QuantizedWeights.dequantizeLinearWeights` already
//  dequantizes every block's weights to float32 on load (see its header —
//  simpler than quantized inference, fine for per-block streaming), so
//  there is nothing to re-quantize here: fusion is just `base + delta` in
//  float32, applied AFTER dequantization and BEFORE the block-relative
//  prefix strip that `TransformerCheckpointLoader.blockWeights`/
//  `topLevelWeights` already do.
//

import MLX

public enum LoRAFusion {
    /// Combined delta for one full (unprefixed-relative to nothing, i.e.
    /// matching `LoRAWeights.pairs`' own keys) weight key across multiple
    /// LoRA sources, or nil if none of them touch this key.
    public static func delta(for key: String, sources: [(weights: LoRAWeights, strength: Float)]) -> MLXArray? {
        var acc: MLXArray?
        for (weights, strength) in sources {
            guard let pair = weights.pairs[key] else { continue }
            let contribution = MLX.matmul(pair.b * strength, pair.a)
            acc = acc.map { $0 + contribution } ?? contribution
        }
        return acc
    }

    /// Fuses LoRA deltas into an already-dequantized, prefix-stripped
    /// weight dict (e.g. `TransformerCheckpointLoader.blockWeights`'s or
    /// `.topLevelWeights`'s return value). `keyPrefix` is what must be
    /// prepended to each relative `*.weight` key to match `LoRAWeights.pairs`'
    /// full checkpoint-relative keys — `"transformer_blocks.\(idx)."` for a
    /// block, `""` for top-level. Keys with no matching LoRA are returned
    /// unchanged (matches `_fuse_deltas`'s "no LoRA for this key" branch,
    /// minus the quantized-weight passthrough since nothing here is
    /// quantized at this point).
    public static func apply(
        to weights: [String: MLXArray], keyPrefix: String,
        sources: [(weights: LoRAWeights, strength: Float)]
    ) -> [String: MLXArray] {
        guard !sources.isEmpty else { return weights }
        var result = weights
        for key in weights.keys where key.hasSuffix(".weight") {
            let base = String(key.dropLast(".weight".count))
            guard let d = delta(for: "\(keyPrefix)\(base)", sources: sources) else { continue }
            result[key] = weights[key]! + d
        }
        return result
    }
}
