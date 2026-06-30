//
//  VerifyEncoderCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-encoder` — Phase 2.2 checkpoint. Loads qwen3-8b, runs
//  get_prompt_embeds on the Python reference input_ids, compares cos > 0.99.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct VerifyEncoder: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-encoder",
            abstract: "Compare Swift Flux2 text encoder (prompt_embeds) against Python mflux reference."
        )

        @Option(help: "Text encoder directory (under models/text_encoder/).")
        var encoder: String = "qwen3-8b"

        @Option(help: "Reference safetensors from gen_flux2_encoder_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/flux2_encoder_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            print("flux2 verify-encoder — Phase 2.2 checkpoint")
            let teURL = ModelPaths.textEncoderRoot.appendingPathComponent(encoder)
            let weights = try Flux2TextEncoderWeights.load(dir: teURL)
            print("loaded \(weights.arrays.count) text encoder weights from \(encoder)")
            print("config: hidden=\(weights.config.hiddenSize), layers=\(weights.config.numLayers), "
                  + "heads=\(weights.config.numHeads)/\(weights.config.numKVHeads), "
                  + "bits=\(weights.config.bits)/gs=\(weights.config.groupSize)")

            let refURL = URL(fileURLWithPath: ref)
            let ref = try loadArrays(url: refURL)
            print("loaded \(ref.count) reference tensors")

            let model = Flux2TextEncoder.build(weights: weights)

            // Load reference input_ids + attention_mask.
            let inputIds = ref["input_ids"]!.asType(.int32)
            let attnMask = ref["attention_mask"]!.asType(.int32)

            print("running get_prompt_embeds on input_ids [\(inputIds.shape)]...")
            let promptEmbeds = model.getPromptEmbeds(inputIds, attentionMask: attnMask).asType(.float32)
            MLX.eval(promptEmbeds)
            print("swift prompt_embeds: \(promptEmbeds.shape)")

            let refEmbeds = ref["prompt_embeds"]!
            MLX.eval(refEmbeds)
            print("ref prompt_embeds:   \(refEmbeds.shape)")

            // Cosine over the full tensor.
            let cosFull = cosine(promptEmbeds, refEmbeds)

            // Cosine over only the non-padded region (more meaningful — padded
            // tokens may differ in low-precision noise).
            let seqLen = attnMask.sum().item(Int.self)
            let swiftActive = promptEmbeds[0, 0..<seqLen, 0..<promptEmbeds.dim(2)]
            let refActive = refEmbeds[0, 0..<seqLen, 0..<refEmbeds.dim(2)]
            let cosActive = cosine(swiftActive, refActive)

            print("")
            print("[full  ]  cos=\(String(format: "%.5f", cosFull))")
            print("[active]  cos=\(String(format: "%.5f", cosActive))  (seqLen=\(seqLen))")
            print("")
            let ok = cosActive >= threshold
            if ok {
                print("✅ FLUX2 TEXT ENCODER MATCHES MFLUX (threshold=\(threshold))")
            } else {
                print("❌ text encoder diverges from Python (cos=\(String(format: "%.5f", cosActive)) < \(threshold))")
            }
            let checks = [
                VerifyCheck(name: "cos_full", pass: cosFull >= threshold, cosine: Double(cosFull),
                            threshold: Double(threshold), detail: "full seq incl. padding"),
                VerifyCheck(name: "cos_active", pass: ok, cosine: Double(cosActive),
                            threshold: Double(threshold), detail: "active (non-padded) tokens, seqLen=\(seqLen) — gate metric"),
            ]
            VerifyReport.write(VerifySummary(
                app: VerifyReport.app, command: "verify-encoder",
                overall_pass: ok, threshold: Double(threshold),
                checks: checks, timestamp: VerifyReport.now()))
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            let cos = dot / (na * nb + 1e-12)
            return cos.item(Float.self)
        }
    }
}
