//
//  LoRAWeights.swift
//  LTXVideoDirector
//
//  Loads an LTX-2.3 distilled/style LoRA safetensors file (ComfyUI/
//  diffusers key layout, e.g. mlx-models/lora/ltx-2.3-distilled/
//  ltx-2.3-22b-distilled-lora-384-1.1.int8.safetensors) into per-weight
//  (lora_A, lora_B) float32 pairs, keyed to match this package's own
//  checkpoint key scheme (see TransformerCheckpointLoader.swift).
//
//  Two things confirmed only by reading the actual vendor/app source, not
//  derivable from the file layout alone:
//
//  1. Int8 dequant (`app/vendor_patches.py`'s `_patch_int8_lora`, Patch 10):
//     `scripts/convert_lora_mlx.py` stores LoRA A/B matrices int8-quantized
//     with a single PER-TENSOR float32 `<key>.scale` sibling — NOT MLX's
//     grouped `mx.quantize` scheme (no `.biases`, no per-group scales; the
//     vendor's stock `ltx_core_mlx.loader.fuse_loras.apply_loras` doesn't
//     dequantize this at all, which is why the app needed its own patch).
//     Dequant is simply `float(int8_value) * scale`.
//  2. Key remap (`ltx_core_mlx.loader.sd_ops.LTXV_LORA_COMFY_RENAMING_MAP`,
//     applied by the same vendor patch before fusion): strip the
//     `diffusion_model.` prefix, `to_out.0` -> `to_out` (list-wrapped
//     Sequential in the reference vs. a single Linear here — same quirk
//     `EmbeddingsConnectorParityTests` already documented for `ff.net.0.proj`),
//     `ff.net.0.proj` -> `ff.proj_in`, `ff.net.2` -> `ff.proj_out`,
//     `linear_1`/`linear_2` -> `linear1`/`linear2` (top-level AdaLN
//     timestep-embedder keys), and the audio-FF variants of the same two
//     `ff.net.*` rules (needed separately because `audio_ff.net.0.proj.`
//     doesn't contain the leading-dot `.ff.net.0.proj.` pattern).
//
//  Fusion itself (delta = strength * B @ A, summed across multiple LoRAs)
//  lives in LoRAFusion.swift.
//

import Foundation
import MLX

/// Renames LoRA safetensors keys from ComfyUI/diffusers layout to this
/// package's checkpoint key scheme. Mirrors
/// `ltx_core_mlx.loader.sd_ops.LTXV_LORA_COMFY_RENAMING_MAP` exactly,
/// including rule order (later rules see earlier rules' output).
public enum LoRAKeyRemap {
    public static func normalize(_ key: String) -> String {
        var k = key
        if k.hasPrefix("diffusion_model.") {
            k = String(k.dropFirst("diffusion_model.".count))
        }
        k = k.replacingOccurrences(of: ".to_out.0.", with: ".to_out.")
        k = k.replacingOccurrences(of: ".ff.net.0.proj.", with: ".ff.proj_in.")
        k = k.replacingOccurrences(of: ".ff.net.2.", with: ".ff.proj_out.")
        k = k.replacingOccurrences(of: ".linear_1.", with: ".linear1.")
        k = k.replacingOccurrences(of: ".linear_2.", with: ".linear2.")
        k = k.replacingOccurrences(of: "audio_ff.net.0.proj.", with: "audio_ff.proj_in.")
        k = k.replacingOccurrences(of: "audio_ff.net.2.", with: "audio_ff.proj_out.")
        return k
    }
}

/// One LoRA file's dequantized A/B pairs, keyed by the base weight key
/// they apply to (with `transformer_blocks.N.` prefix retained for block
/// params, matching model_sd's full key scheme — LoRAFusion.apply strips
/// the prefix back off per-block/top-level to match already-loaded arrays).
public struct LoRAWeights {
    public let pairs: [String: (a: MLXArray, b: MLXArray)]

    public init(pairs: [String: (a: MLXArray, b: MLXArray)]) {
        self.pairs = pairs
    }

    public static func load(url: URL) throws -> LoRAWeights {
        let raw = try MLX.loadArrays(url: url)

        // Step 1: int8 * scale dequant (see file header, point 1). Any key
        // without a `.scale` sibling is assumed already float — passed
        // through as-is (cast to float32).
        var scales: [String: MLXArray] = [:]
        for (key, value) in raw where key.hasSuffix(".scale") {
            scales[String(key.dropLast(".scale".count))] = value
        }
        var dequantized: [String: MLXArray] = [:]
        for (key, value) in raw where !key.hasSuffix(".scale") {
            if let scale = scales[key] {
                dequantized[key] = value.asType(.float32) * scale.asType(.float32)
            } else {
                dequantized[key] = value.asType(.float32)
            }
        }

        // Step 2: key remap, then group into (a, b) pairs by base key.
        var aArrays: [String: MLXArray] = [:]
        var bArrays: [String: MLXArray] = [:]
        for (key, value) in dequantized {
            let remapped = LoRAKeyRemap.normalize(key)
            if remapped.hasSuffix(".lora_A.weight") {
                aArrays[String(remapped.dropLast(".lora_A.weight".count))] = value
            } else if remapped.hasSuffix(".lora_B.weight") {
                bArrays[String(remapped.dropLast(".lora_B.weight".count))] = value
            }
        }
        var pairs: [String: (a: MLXArray, b: MLXArray)] = [:]
        for (base, a) in aArrays {
            if let b = bArrays[base] {
                pairs[base] = (a: a, b: b)
            }
        }
        return LoRAWeights(pairs: pairs)
    }
}
