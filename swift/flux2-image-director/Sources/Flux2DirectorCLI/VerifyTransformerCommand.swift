//
//  VerifyTransformerCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-transformer` — Phase 2.3 checkpoint. Loads the klein-9b
//  transformer, runs ONE forward pass on the Python reference inputs, compares
//  the noise output (cos > 0.99).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct VerifyTransformer: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-transformer",
            abstract: "Compare Swift Flux2 transformer (1 step) against Python mflux reference."
        )

        @Option(help: "Transformer directory (under models/transformer/).")
        var transformer: String = "klein-9b"

        @Option(help: "Reference safetensors from gen_flux2_transformer_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/flux2_transformer_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 verify-transformer — Phase 2.3 checkpoint")
            let tfURL = ModelPaths.transformerRoot.appendingPathComponent(transformer)
            let weights = try Flux2TransformerWeights.load(dir: tfURL)
            print("loaded \(weights.arrays.count) transformer weights from \(transformer)")
            print("config: double=\(weights.config.numLayers) single=\(weights.config.numSingleLayers) "
                  + "heads=\(weights.config.numAttentionHeads) headDim=\(weights.config.attentionHeadDim) "
                  + "inner=\(weights.config.innerDim)")

            let ref = try loadArrays(url: URL(fileURLWithPath: ref))
            print("loaded \(ref.count) reference tensors")

            let model = Flux2Transformer.build(weights: weights)

            // Helper to compare an intermediate against the Python reference.
            var checks: [VerifyCheck] = []
            func cmp(_ name: String, _ swift: MLXArray) {
                guard let pyRef = ref[name] else { print("  [\(name)] (no ref)"); return }
                let s = swift.asType(.float32); let p = pyRef
                MLX.eval(s, p)
                let c = cosine(s, p)
                print("  [\(name)] cos=\(String(format: ".%.5f", c))  swift=\(s.shape)")
                let shape = s.shape.map(String.init).joined(separator: ",")
                checks.append(VerifyCheck(name: name, pass: true, cosine: Double(c), threshold: nil,
                                          detail: "diagnostic intermediate, swift=[\(shape)]"))
            }

            let latents = ref["latents"]!.asType(.bfloat16)
            let latentIds = ref["latent_ids"]!.asType(.int32)
            let promptEmbeds = ref["prompt_embeds"]!.asType(.bfloat16)
            let textIds = ref["text_ids"]!.asType(.int32)
            let timestep = ref["timestep"]!.asType(.bfloat16)

            print("=== initial latent RNG check ===")
            let (genLat, _, _, _) = Flux2LatentCreator.preparePackedLatents(
                seed: 777, height: 512, width: 512)
            MLX.eval(genLat)
            if let refLat = ref["latents"] {
                let c = cosine(genLat.asType(.float32), refLat.asType(.float32))
                print("  generated-vs-ref cos=\(String(format: "%.5f", c))  "
                      + "(gen sum=\(String(format: "%.2f", genLat.sum().item(Float.self))) "
                      + "ref sum=\(String(format: "%.2f", refLat.sum().item(Float.self))))")
            }

            print("=== intermediate comparison ===")
            let inter = model.diagnose(hiddenStates: latents, encoderHiddenStates: promptEmbeds,
                                       timestep: timestep, imgIds: latentIds, txtIds: textIds)
            for k in ["te_raw", "temb", "hidden_post_embed", "enc_post_embed", "rope_cos",
                      "enc_after_db0", "hidden_after_db0"] {
                if let swift = inter[k] { cmp(k, swift) }
            }

            print("=== full forward ===")

            let noise = model(
                hiddenStates: latents,
                encoderHiddenStates: promptEmbeds,
                timestep: timestep,
                imgIds: latentIds,
                txtIds: textIds
            ).asType(.float32)
            MLX.eval(noise)
            print("swift noise: \(noise.shape)")

            let refNoise = ref["noise"]!
            MLX.eval(refNoise)
            print("ref noise:   \(refNoise.shape)")

            let cos = cosine(noise, refNoise)
            // Stats on the difference.
            let diff = noise - refNoise
            let maxAbsDiff = MLX.max(MLX.abs(diff)).item(Float.self)
            let meanAbsDiff = MLX.mean(MLX.abs(diff)).item(Float.self)
            let meanRef = MLX.mean(MLX.abs(refNoise)).item(Float.self)

            print("")
            print("[cos]  \(String(format: "%.5f", cos))")
            print("[diff] max=\(String(format: "%.4f", maxAbsDiff)) mean=\(String(format: "%.5f", meanAbsDiff))  (ref mean|val|=\(String(format: "%.3f", meanRef)))")
            print("")
            if cos >= threshold {
                print("✅ FLUX2 TRANSFORMER MATCHES MFLUX (threshold=\(threshold))")
            } else {
                print("❌ transformer diverges from Python (cos=\(String(format: "%.5f", cos)) < \(threshold))")
            }
            checks.append(VerifyCheck(name: "forward_noise", pass: cos >= threshold, cosine: Double(cos),
                                      threshold: Double(threshold),
                                      detail: "maxDiff=\(String(format: "%.4f", maxAbsDiff)) meanDiff=\(String(format: "%.5f", meanAbsDiff)) swift=\(noise.shape)"))
            VerifyReport.write(VerifySummary(
                app: VerifyReport.app, command: "verify-transformer",
                overall_pass: cos >= threshold, threshold: Double(threshold),
                checks: checks, timestamp: VerifyReport.now()))
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            return (dot / (na * nb + 1e-12)).item(Float.self)
        }
    }
}
