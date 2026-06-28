//
//  VerifyVAECommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-vae` — Phase 2.1 checkpoint. Loads the Flux2 Klein VAE,
//  runs encode + decode + decodePackedLatents on the Python reference
//  tensors, and reports cosine similarity (target: cos > 0.99).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct VerifyVAE: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-vae",
            abstract: "Compare Swift Flux2 VAE (encode/decode/packed) against Python mflux reference."
        )

        @Option(help: "VAE variant directory (under models/vae/).")
        var vae: String = "flux2-klein"

        @Option(help: "Reference safetensors from gen_flux2_vae_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/flux2_vae_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            print("flux2 verify-vae — Phase 2.1 checkpoint")
            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(vae)
            // Flux2 VAE is sharded (0.safetensors); load all shards.
            let weights = try loadAllShards(vaeURL: vaeURL)
            print("loaded \(weights.count) VAE weights from \(vae)")

            let refURL = URL(fileURLWithPath: ref)
            let ref = try loadArrays(url: refURL)
            print("loaded \(ref.count) reference tensors from \(refURL.lastPathComponent)")

            let encoder = Flux2VAEEncoder(weights: weights)
            let decoder = Flux2VAEDecoder(weights: weights)
            let bn = Flux2BatchNormStats(
                runningMean: weights["bn.running_mean"]!,
                runningVar: weights["bn.running_var"]!
            )

            var passed = 0
            var total = 0

            // --- ENCODE: image (1,3,256,256) → latent (1,32,32,32) ---
            let img = ref["input_image"]!.asType(.bfloat16)
            let swiftLatent = encoder(img).asType(.float32)
            MLX.eval(swiftLatent)
            let refLatent = ref["encoded_latent"]!
            let encCos = cosine(swiftLatent, refLatent)
            let encOK = encCos >= threshold
            total += 1; if encOK { passed += 1 }
            print("")
            print("[encode]   swift=\(shapeStr(swiftLatent))  ref=\(shapeStr(refLatent))")
            print("           cos=\(String(format: "%.5f", encCos))  \(encOK ? "✅ PASS" : "❌ FAIL")")

            // --- DECODE: latent (1,32,32,32) → pixels (1,3,256,256) ---
            let lat = ref["encoded_latent"]!.asType(.bfloat16)
            let swiftPixels = decoder(lat).asType(.float32)
            MLX.eval(swiftPixels)
            let refPixels = ref["decoded_pixels"]!
            let decCos = cosine(swiftPixels, refPixels)
            let decOK = decCos >= threshold
            total += 1; if decOK { passed += 1 }
            print("")
            print("[decode]   swift=\(shapeStr(swiftPixels))  ref=\(shapeStr(refPixels))")
            print("           cos=\(String(format: "%.5f", decCos))  \(decOK ? "✅ PASS" : "❌ FAIL")")

            // --- DECODE PACKED: (1,128,16,16) → pixels (1,3,256,256) ---
            // T2I generation path: bn denorm → unpatchify → decode.
            let packed = ref["packed_latent"]!.asType(.bfloat16)
            let swiftPacked = decoder.decodePackedLatents(packed, bn: bn).asType(.float32)
            MLX.eval(swiftPacked)
            let refPacked = ref["decoded_packed_pixels"]!
            let pkCos = cosine(swiftPacked, refPacked)
            let pkOK = pkCos >= threshold
            total += 1; if pkOK { passed += 1 }
            print("")
            print("[packed]   swift=\(shapeStr(swiftPacked))  ref=\(shapeStr(refPacked))")
            print("           cos=\(String(format: "%.5f", pkCos))  \(pkOK ? "✅ PASS" : "❌ FAIL")")

            print("")
            if passed == total {
                print("✅ FLUX2 VAE MATCHES MFLUX (\(passed)/\(total), threshold=\(threshold))")
            } else {
                print("❌ \(total - passed)/\(total) VAE CHECKS FAILED")
            }
        }

        // Load all *.safetensors shards in the VAE directory into one dict.
        private func loadAllShards(vaeURL: URL) throws -> [String: MLXArray] {
            var all: [String: MLXArray] = [:]
            let files = (try FileManager.default.contentsOfDirectory(at: vaeURL, includingPropertiesForKeys: nil))
                .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for f in files {
                let shard = try loadArrays(url: f)
                all.merge(shard) { _, new in new }
            }
            return all
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            let cos = dot / (na * nb + 1e-12)
            return cos.item(Float.self)
        }

        private func shapeStr(_ a: MLXArray) -> String {
            "[\(a.shape.map(String.init).joined(separator: ", "))]"
        }
    }
}
