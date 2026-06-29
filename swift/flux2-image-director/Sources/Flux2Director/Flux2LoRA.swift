//
//  Flux2LoRA.swift
//  Flux2Director
//
//  LoRA adapter loading for Flux2 Klein 9B. Ports mflux's
//  Flux2LoRAMapping (BFL/ComfyUI naming) + LoRALoader (delta computation)
//  + LoraTransforms (fused QKV split).
//
//  The anime2real LoRA uses BFL naming:
//    diffusion_model.double_blocks.{N}.img_attn.qkv.lora_{A,B}.weight  (+.scale)
//    diffusion_model.double_blocks.{N}.img_attn.proj ...
//    diffusion_model.double_blocks.{N}.img_mlp.{0,2} ...
//    diffusion_model.double_blocks.{N}.txt_attn.qkv / .proj
//    diffusion_model.double_blocks.{N}.txt_mlp.{0,2} ...
//    diffusion_model.single_blocks.{N}.linear{1,2} ...
//
//  BFL source → Swift transformer model_path (1:1 with mflux model_path):
//    double_blocks.N.img_attn.qkv  → transformer_blocks.N.attn.to_{q,k,v} (fused split)
//    double_blocks.N.img_attn.proj → transformer_blocks.N.attn.to_out
//    double_blocks.N.img_mlp.0     → transformer_blocks.N.ff.linear_in
//    double_blocks.N.img_mlp.2     → transformer_blocks.N.ff.linear_out
//    double_blocks.N.txt_attn.qkv  → transformer_blocks.N.attn.add_{q,k,v}_proj (fused split)
//    double_blocks.N.txt_attn.proj → transformer_blocks.N.attn.to_add_out
//    double_blocks.N.txt_mlp.0     → transformer_blocks.N.ff_context.linear_in
//    double_blocks.N.txt_mlp.2     → transformer_blocks.N.ff_context.linear_out
//    single_blocks.N.linear1       → single_transformer_blocks.N.attn.to_qkv_mlp_proj (no split)
//    single_blocks.N.linear2       → single_transformer_blocks.N.attn.to_out
//
//  int8 weights are dequantized to float32 (int8 * scalar_scale), then stored as
//  adapter matrices: loraA (in,r), loraB (r,out). At runtime F2QLinear computes:
//    base + loraScale * matmul(matmul(x, loraA), loraB)
//

import CommonImageDirector
import Foundation
import MLX

/// One LoRA adapter for a single target linear layer.
public struct Flux2LoRAAdapter {
    public let loraA: MLXArray   // (in_dims, r) float32
    public let loraB: MLXArray   // (r, out_dims) float32
}

/// Dictionary mapping a Swift transformer model_path (e.g.
/// "transformer_blocks.3.attn.to_q") to its computed LoRA adapter.
public struct Flux2LoRAAdapters {
    public let adapters: [String: Flux2LoRAAdapter]
    public let scale: Float

    public static func none() -> Flux2LoRAAdapters { Flux2LoRAAdapters(adapters: [:], scale: 1.0) }

    public func adapter(for key: String) -> Flux2LoRAAdapter? { adapters[key] }
}

/// Errors thrown by `Flux2LoRALoader.resolveFile`.
public enum Flux2LoRAError: Error, CustomStringConvertible {
    case directoryNotFound(name: String, path: String)
    case noSafetensors(name: String)

    public var description: String {
        switch self {
        case let .directoryNotFound(name, path): return "LoRA directory not found: \(name) (\(path))"
        case let .noSafetensors(name): return "no .safetensors in LoRA dir '\(name)'"
        }
    }
}

/// Loads a Flux2 BFL-named LoRA safetensors file and computes per-target adapters.
public enum Flux2LoRALoader {

    /// Resolve the single LoRA safetensors file inside models/lora/<name>/.
    /// Prefers an `*.int8.safetensors`, falls back to the first safetensors.
    /// Shared by all CLI commands that accept LoRA names (style/scene/...).
    public static func resolveFile(name: String) throws -> URL {
        let dir = ModelPaths.loraRoot.appendingPathComponent(name)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir),
              isDir.boolValue else {
            throw Flux2LoRAError.directoryNotFound(name: name, path: dir.path)
        }
        let files = (try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))
            .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
        guard !files.isEmpty else {
            throw Flux2LoRAError.noSafetensors(name: name)
        }
        if let int8 = files.first(where: { $0.lastPathComponent.contains("int8") }) {
            return int8
        }
        return files.sorted { $0.lastPathComponent < $1.lastPathComponent }[0]
    }

    /// Merge N loaded adapters into a single higher-rank adapter, so the
    /// single-adapter runtime path (`base + scale·(x@A)@B`) applies the sum of
    /// all LoRAs. Per the rank-stacking identity, for each target key present in
    /// ≥1 input:
    ///   A_merged = hstack(sqrt(s_i) · A_i)   shape (in, Σr)
    ///   B_merged = vstack(sqrt(s_i) · B_i)   shape (Σr, out)
    /// so that  (x @ A_merged) @ B_merged = Σ_i s_i · (x @ A_i) @ B_i.
    /// Each input's `scale` is baked into A/B; the merged adapter's scale = 1.0.
    /// A merge of ONE adapter is numerically identical to loading it directly
    /// (scale folded into sqrt·A, sqrt·B). Keys present in only some inputs are
    /// simply omitted from the others (each contributes only its own blocks).
    public static func merge(_ inputs: [Flux2LoRAAdapters]) -> Flux2LoRAAdapters {
        guard inputs.count > 1 else {
            // 0 or 1 input: nothing to stack; return as-is (or none).
            return inputs.first ?? Flux2LoRAAdapters.none()
        }
        var keys = Set<String>()
        for a in inputs { keys.formUnion(a.adapters.keys) }
        var merged: [String: Flux2LoRAAdapter] = [:]
        for key in keys {
            var aParts: [MLXArray] = []
            var bParts: [MLXArray] = []
            for a in inputs {
                guard let ad = a.adapter(for: key) else { continue }
                let s = MLXArray(a.scale.squareRoot()).asType(ad.loraA.dtype)
                aParts.append(ad.loraA * s)   // (in, r)
                bParts.append(ad.loraB * s)   // (r, out)
            }
            guard !aParts.isEmpty else { continue }
            let A = MLX.concatenated(aParts, axis: 1)   // (in, Σr)
            let B = MLX.concatenated(bParts, axis: 0)   // (Σr, out)
            merged[key] = Flux2LoRAAdapter(loraA: A, loraB: B)
        }
        return Flux2LoRAAdapters(adapters: merged, scale: 1.0)
    }

    /// Load + compute adapters from an int8-quantized BFL-named LoRA file.
    /// `scale` is the user LoRA scale (mflux effective_scale, default 1.0).
    public static func load(url: URL, scale: Float = 1.0) throws -> Flux2LoRAAdapters {
        let raw = try loadArrays(url: url)
        var adapters: [String: Flux2LoRAAdapter] = [:]

        // Group raw keys by source target: "double_blocks.3.img_attn.qkv" → {A, B, A.scale, B.scale}
        // Strip the "diffusion_model." prefix and the trailing ".lora_{A,B}.weight[.scale]".
        struct Matrices { var aInt8: MLXArray?; var aScale: MLXArray?
                          var bInt8: MLXArray?; var bScale: MLXArray? }
        var grouped: [String: Matrices] = [:]
        for (key, val) in raw {
            guard key.hasPrefix("diffusion_model.") else { continue }
            let body = String(key.dropFirst("diffusion_model.".count))
            // Match suffix patterns.
            if let m = matchSuffix(body, ".lora_A.weight") {
                grouped[m, default: Matrices()].aInt8 = val
            } else if let m = matchSuffix(body, ".lora_A.weight.scale") {
                grouped[m, default: Matrices()].aScale = val
            } else if let m = matchSuffix(body, ".lora_B.weight") {
                grouped[m, default: Matrices()].bInt8 = val
            } else if let m = matchSuffix(body, ".lora_B.weight.scale") {
                grouped[m, default: Matrices()].bScale = val
            }
        }

        for (srcTarget, mat) in grouped {
            guard let aInt8 = mat.aInt8, let bInt8 = mat.bInt8,
                  let aScaleArr = mat.aScale, let bScaleArr = mat.bScale else {
                continue
            }
            // Dequantize: float(int8) * scale. Scale is scalar ().
            let aScale = aScaleArr.item(Float.self)
            let bScale = bScaleArr.item(Float.self)
            let loraAfull = aInt8.asType(.float32) * aScale   // (r, in_dims)
            let loraBfull = bInt8.asType(.float32) * bScale   // (out_dims_total, r)

            // Resolve BFL source target → list of (modelPath, splitIndex or nil).
            let targets = bflToModelPaths(srcTarget)
            for (modelPath, splitIdx) in targets {
                let a: MLXArray
                let b: MLXArray
                if let idx = splitIdx {
                    // Fused QKV: split B into 3 equal row-chunks; A is shared (not split,
                    // since r=16 % 3 ≠ 0 — matches mflux split_*_down returning full).
                    let outTotal = loraBfull.dim(0)
                    let chunk = outTotal / 3
                    let bSlice = loraBfull[(idx * chunk)..<((idx + 1) * chunk), 0...]  // (chunk, r)
                    a = loraAfull.transposed(1, 0)   // (in_dims, r)  [A stored as (r, in_dims)]
                    b = bSlice.transposed(1, 0)       // (r, chunk)
                } else {
                    // No split: full matrices.
                    a = loraAfull.transposed(1, 0)   // (in_dims, r)
                    b = loraBfull.transposed(1, 0)   // (r, out_dims)
                }
                adapters[modelPath] = Flux2LoRAAdapter(loraA: a, loraB: b)
            }
        }
        return Flux2LoRAAdapters(adapters: adapters, scale: scale)
    }

    /// Strip a suffix from a key body, returning the prefix if it matches.
    private static func matchSuffix(_ body: String, _ suffix: String) -> String? {
        guard body.hasSuffix(suffix) else { return nil }
        return String(body.dropLast(suffix.count))
    }

    /// Map a BFL source target (e.g. "double_blocks.3.img_attn.qkv") to one or
    /// more (modelPath, splitIndex) pairs. splitIndex=nil means no QKV split.
    private static func bflToModelPaths(_ src: String) -> [(String, Int?)] {
        // Parse: {double_blocks|single_blocks}.{N}.{component}
        let parts = src.split(separator: ".", maxSplits: 2)
        guard parts.count == 3 else { return [] }
        let blockType = String(parts[0])     // "double_blocks" or "single_blocks"
        let blockIdx = String(parts[1])      // "3"
        let comp = String(parts[2])          // "img_attn.qkv" etc.

        if blockType == "double_blocks" {
            let p = "transformer_blocks.\(blockIdx)"
            switch comp {
            case "img_attn.qkv":
                return [("\(p).attn.to_q", 0), ("\(p).attn.to_k", 1), ("\(p).attn.to_v", 2)]
            case "img_attn.proj":  return [("\(p).attn.to_out", nil)]
            case "img_mlp.0":      return [("\(p).ff.linear_in", nil)]
            case "img_mlp.2":      return [("\(p).ff.linear_out", nil)]
            case "txt_attn.qkv":
                return [("\(p).attn.add_q_proj", 0), ("\(p).attn.add_k_proj", 1), ("\(p).attn.add_v_proj", 2)]
            case "txt_attn.proj":  return [("\(p).attn.to_add_out", nil)]
            case "txt_mlp.0":      return [("\(p).ff_context.linear_in", nil)]
            case "txt_mlp.2":      return [("\(p).ff_context.linear_out", nil)]
            default: return []
            }
        } else if blockType == "single_blocks" {
            let p = "single_transformer_blocks.\(blockIdx)"
            switch comp {
            case "linear1": return [("\(p).attn.to_qkv_mlp_proj", nil)]
            case "linear2": return [("\(p).attn.to_out", nil)]
            default: return []
            }
        }
        return []
    }
}
