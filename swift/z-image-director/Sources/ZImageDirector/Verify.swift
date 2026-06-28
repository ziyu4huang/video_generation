//
//  Verify.swift
//  ZImageDirector
//
//  Phase 2 verification: load the Python reference dump and compare the Swift
//  transformer's outputs against ground truth, layer by layer.
//
//  Driven by `zimage verify` (see main.swift).
//

import CommonImageDirector
import Foundation
import MLX
import MLXNN

/// Result of comparing a Swift tensor to a Python reference tensor.
public struct TensorComparison: Sendable {
    public let name: String
    public let maxAbsDiff: Float
    public let meanAbsDiff: Float
    public let referenceShape: [Int]
    public let refMaxMag: Float   // max |reference| — for relative tolerance
    public let passed: Bool

    /// Relative max error = maxAbsDiff / refMaxMag (robust to scale).
    public var relMaxDiff: Float {
        refMaxMag > 0 ? maxAbsDiff / refMaxMag : maxAbsDiff
    }

    public var summary: String {
        let flag = passed ? "✓" : "✗ FAIL"
        return "  \(flag) \(name.padding(toLength: 22, withPad: " ", startingAt: 0)) " +
            "maxAbs=\(String(format: "%.2e", maxAbsDiff)) " +
            "relMax=\(String(format: "%.2e", relMaxDiff)) " +
            "mean=\(String(format: "%.2e", meanAbsDiff))"
    }
}

public enum Verify {

    /// Compare every value in `swift` against `reference` (assumed same shape).
    /// `tolerance` is an ABSOLUTE max-diff threshold; for scale-robust checks
    /// use `relTolerance` (relative to the reference's max magnitude).
    public static func compare(
        _ name: String, swift: MLXArray, reference: MLXArray,
        tolerance: Float = 1e9, relTolerance: Float = 0.05
    ) -> TensorComparison {
        let diff = MLX.abs(swift.asType(.float32) - reference.asType(.float32))
        let maxAbs = Float(MLX.max(diff).item(Float.self)) ?? .infinity
        let meanAbs = Float(MLX.mean(diff).item(Float.self)) ?? .infinity
        let refMag = Float(MLX.max(MLX.abs(reference.asType(.float32))).item(Float.self)) ?? 1.0
        let relMax = refMag > 0 ? maxAbs / refMag : maxAbs
        let passed = maxAbs <= tolerance && relMax <= relTolerance
        return TensorComparison(
            name: name,
            maxAbsDiff: maxAbs,
            meanAbsDiff: meanAbs,
            referenceShape: reference.shape,
            refMaxMag: refMag,
            passed: passed
        )
    }

    /// Run the full Phase 2 verification against the Python reference dump.
    /// Returns the list of per-tensor comparisons.
    public static func runReferenceCheck(
        refDir: URL,
        weights: [String: MLXArray],
        config: TransformerConfig,
        groupSize: Int = 64,
        bits: Int = 8,
        tolerance: Float = 2e-2
    ) throws -> [TensorComparison] {
        let inputs = try loadArrays(url: refDir.appendingPathComponent("ref_inputs.safetensors"))
        let ref = try loadArrays(url: refDir.appendingPathComponent("ref_intermediates.safetensors"))

        let x = inputs["x"]!
        let t = inputs["t"]!
        let capFeats = inputs["cap_feats"]!
        let xPos = inputs["img_pos"]!
        let capPos = inputs["cap_pos"]!
        let cos = inputs["cos"]!
        let sin = inputs["sin"]!

        let loader = TransformerWeightLoader(weights: weights, config: config, groupSize: groupSize, bits: bits)
        let model = ZImageTransformer(weights: weights, config: config, groupSize: groupSize, bits: bits)

        var results: [TensorComparison] = []

        // Timestep embedder.
        let temb = model.tEmbedder(t * Float(config.tScale))
        results.append(compare("temb", swift: temb, reference: ref["temb"]!, tolerance: tolerance))

        // x_embedder.
        let xEmb = model.xEmbedder(x)
        results.append(compare("x_embedder", swift: xEmb, reference: ref["x_embedder"]!))

        // cap_embedder.
        let cap = model.capEmbedderLinear(model.capEmbedderNorm(capFeats))
        results.append(compare("cap_embedder", swift: cap, reference: ref["cap_embedder"]!))

        // RoPE (prepare_rope).
        let (cosSw, sinSw) = model.prepareRope(positions: MLX.concatenated([xPos, capPos], axis: 1))
        results.append(compare("rope_cos", swift: cosSw, reference: cos))
        results.append(compare("rope_sin", swift: sinSw, reference: sin))

        // Noise refiners.
        var xi = xEmb
        var cosImg = cos[0..., 0..<xi.dim(1)]
        var sinImg = sin[0..., 0..<xi.dim(1)]
        for (i, blk) in model.noiseRefiner.enumerated() {
            xi = blk(xi, mask: nil, positions: xPos, adalnInput: temb, cos: cosImg, sin: sinImg)
            cosImg = cos[0..., 0..<xi.dim(1)]
            sinImg = sin[0..., 0..<xi.dim(1)]
            results.append(compare("noise_refiner.\(i)", swift: xi, reference: ref["noise_refiner.\(i)"]!))
        }

        // Context refiners.
        var capR = cap
        for (i, blk) in model.contextRefiner.enumerated() {
            capR = blk(capR, mask: nil, positions: capPos, adalnInput: nil,
                       cos: cos[0..., xi.dim(1)...], sin: sin[0..., xi.dim(1)...])
            results.append(compare("context_refiner.\(i)", swift: capR, reference: ref["context_refiner.\(i)"]!))
        }

        // Main layers.
        let xLen = xi.dim(1)
        var unified = MLX.concatenated([xi, capR], axis: 1)
        let unifiedPos = MLX.concatenated([xPos, capPos], axis: 1)
        results.append(compare("unified_pre", swift: unified, reference: ref["unified_pre_layers"]!))
        for (i, blk) in model.layers.enumerated() {
            unified = blk(unified, mask: nil, positions: unifiedPos, adalnInput: temb, cos: cos, sin: sin)
            // Sample every 5th layer to keep output readable (30 layers).
            if i % 5 == 0 || i == model.layers.count - 1 {
                results.append(compare("layers.\(i)", swift: unified, reference: ref["layers.\(i)"]!))
            }
        }

        // Final layer + full output.
        let final = model.finalLayer(unified[0..., 0..<xLen, 0...], temb)
        results.append(compare("final_layer", swift: final, reference: ref["final_layer"]!))

        let full = model(x: x, t: t, capFeats: capFeats, xPos: xPos, capPos: capPos, cos: cos, sin: sin)
        results.append(compare("full_output", swift: full, reference: ref["full_output"]!))

        return results
    }

    // MARK: - Phase 4: VAE decoder

    /// Decode the Python reference latent with the Swift VAE and compare.
    public static func runVAECheck(
        refDir: URL, vaeWeights: [String: MLXArray]
    ) throws -> [TensorComparison] {
        let data = try loadArrays(url: refDir.appendingPathComponent("ref_vae.safetensors"))
        let inter: [String: MLXArray] = (try? loadArrays(url: refDir.appendingPathComponent("ref_vae_inter.safetensors"))) ?? [:]
        let gn: [String: MLXArray] = (try? loadArrays(url: refDir.appendingPathComponent("ref_gn.safetensors"))) ?? [:]
        let latents = data["latents"]!
        let decodedRaw = data["decoded_raw"]!
        let decodedImage = data["decoded_image"]!

        var results: [TensorComparison] = []

        // Isolated GroupNorm sanity check.
        if let gnIn = gn["in"] {
            let myGN = LoadedGroupNorm(weight: gn["w"]!, bias: gn["b"]!)
            let myOut = myGN(gnIn.asType(.bfloat16))
            results.append(compare("groupnorm_isolated", swift: myOut, reference: gn["out"]!,
                                   tolerance: 1.0, relTolerance: 0.05))
        }

        let vae = ZImageVAEDecoder(weights: vaeWeights)
        let latentsBf = latents.asType(.bfloat16)

        // Replicate the decoder forward step-by-step to compare intermediates.
        // IMPORTANT: match VAE.decode — apply (latents/0.3611)+0.1159 first.
        let scaledLatents = (latentsBf / Float(0.3611)) + Float(0.1159)
        let convInOut = vae.convInCall(scaledLatents)
        let midR0 = vae.midBlock.resnet1(convInOut)
        let midAtt = vae.midBlock.attention(midR0)
        let midR1 = vae.midBlock.resnet2(midAtt)
        let midOut = midR1

        // Walk up_blocks manually to localize divergence.
        // Note: up_block 3 values reach ~450 magnitude (pre-norm); use a large
        // abs gate and rely on relTolerance for these.
        var ub = midOut
        for (idx, up) in vae.upBlocks.enumerated() {
            ub = up(ub)
            if let ref = inter["up\(idx)_out"] {
                results.append(compare("up\(idx)", swift: ub, reference: ref,
                                       tolerance: 1e4, relTolerance: 0.05))
            }
        }

        // Tail: convNormOut → silu → convOut. Python's ConvNormOut/ConvOut each
        // transpose NCHW→NHWC internally; they TAKE NCHW and RETURN NCHW.
        let tailURL = refDir.appendingPathComponent("ref_vae_tail.safetensors")
        let tail: [String: MLXArray]
        do { tail = try loadArrays(url: tailURL) }
        catch { print("⚠️ tail load failed: \(error)  [\(tailURL.path)]"); tail = [:] }
        var tailH = vae.convNormOutApply(ub)
        if let r = tail["conv_norm_out"] {
            results.append(compare("conv_norm_out", swift: tailH, reference: r,
                                   tolerance: 1.0, relTolerance: 0.05))
        }
        tailH = MLXNN.silu(tailH)
        tailH = vae.convOutApply(tailH)
        if let r = tail["conv_out"] {
            results.append(compare("conv_out", swift: tailH, reference: r,
                                   tolerance: 1.0, relTolerance: 0.05))
        }

        results.append(compare("conv_in", swift: convInOut, reference: inter["conv_in_out"]!,
                               tolerance: 1.0, relTolerance: 0.05))
        results.append(compare("mid_resnet0", swift: midR0, reference: inter["mid_resnet0"]!,
                               tolerance: 1.0, relTolerance: 0.05))
        results.append(compare("mid_attn", swift: midAtt, reference: inter["mid_attn"]!,
                               tolerance: 1.0, relTolerance: 0.05))
        results.append(compare("mid_block", swift: midOut, reference: inter["mid_block_out"]!,
                               tolerance: 1.0, relTolerance: 0.05))

        // Full decode (vae() applies latent scale+shift then the decoder).
        let decoded = vae(latentsBf)
        results.append(compare("vae_decoded_raw", swift: decoded, reference: decodedRaw,
                               tolerance: 1.0, relTolerance: 0.05))

        // Post-processed image (clip(/2 + 0.5, 0, 1)).
        let img = MLX.clip(decoded.asType(.float32) / 2.0 + 0.5, min: 0, max: 1)
        results.append(compare("vae_image", swift: img, reference: decodedImage,
                               tolerance: 1.0, relTolerance: 0.05))
        return results
    }
}
