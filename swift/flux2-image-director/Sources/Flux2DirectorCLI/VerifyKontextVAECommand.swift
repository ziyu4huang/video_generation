//
//  VerifyKontextVAECommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-kontext-vae` — kontext epic phase 4 item 1 NUMERIC parity
//  checkpoint (see output/next-goal-20260714_200847.md). Loads the MLX
//  weights produced by `convert_kontext_vae_to_mlx()`
//  (python/mlx-movie-director/convert.py) into `ZImageVAEEncoder`/
//  `ZImageVAEDecoder` (reused as-is: Kontext's VAE config is byte-identical
//  to Z-Image's, both trace back to FLUX.1-dev's VAE) and compares against
//  `gen_kontext_vae_ref.py`'s real-weight, independently-derived-mapping
//  Python output (cos > threshold). Do not declare this phase done on a
//  shape-only check — that mistake already happened once with the
//  transformer (see the epic doc's phase 2 section).
//

import ArgumentParser
import Flux2Director
import Foundation
import MLX
import ZImageDirector

extension Flux2CLI {
    struct VerifyKontextVAE: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-kontext-vae",
            abstract: "Compare Swift ZImageVAEEncoder/Decoder (loaded with converted Kontext weights) against real-weight Python mflux reference (numeric parity)."
        )

        @Option(help: "Converted MLX Kontext VAE weights (from convert_kontext_vae_to_mlx()).")
        var weights: String = "mlx-models/vae/flux-kontext-ae/model.safetensors"

        @Option(help: "Reference safetensors from gen_kontext_vae_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/kontext_vae_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 verify-kontext-vae — kontext epic phase 4 numeric-parity checkpoint")

            let weightsURL = URL(fileURLWithPath: weights)
            guard FileManager.default.fileExists(atPath: weightsURL.path) else {
                print("ERROR: converted weights not found at \(weightsURL.path)")
                print("Generate them first: python/venv/bin/python "
                      + "python/mlx-movie-director/convert.py --kontext-vae-mlx")
                throw ExitCode.failure
            }
            let vaeWeights = try loadArrays(url: weightsURL)
            print("loaded \(vaeWeights.count) converted MLX VAE weights")

            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it first: python/venv/bin/python "
                      + "python/mlx-movie-director/app/tests/gen_kontext_vae_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)
            print("loaded \(refTensors.count) reference tensors")

            let encoder = ZImageVAEEncoder(weights: vaeWeights)
            let decoder = ZImageVAEDecoder(weights: vaeWeights)

            let inputImage = refTensors["input_image"]!.asType(.bfloat16)
            let refLatent = refTensors["encoded_latent"]!.asType(.float32)
            let refDecoded = refTensors["decoded_pixels"]!.asType(.float32)
            MLX.eval(inputImage, refLatent, refDecoded)

            print("=== encode ===")
            let latent = encoder(inputImage).asType(.float32)
            MLX.eval(latent)
            print("swift latent: \(latent.shape)   ref latent: \(refLatent.shape)")
            let encodeCos = cosine(latent, refLatent)
            let encodeMaxAbsDiff = MLX.max(MLX.abs(latent - refLatent)).item(Float.self)
            print("[encode cos]  \(String(format: "%.5f", encodeCos))  maxAbsDiff=\(String(format: "%.4f", encodeMaxAbsDiff))")

            print("=== decode ===")
            // Decode straight from the Python-encoded reference latent (not
            // the Swift-encoded one) so a decode bug can't hide behind an
            // encode bug cancelling it out, or vice versa.
            let decoded = decoder(refLatent.asType(.bfloat16)).asType(.float32)
            MLX.eval(decoded)
            print("swift decoded: \(decoded.shape)   ref decoded: \(refDecoded.shape)")
            let decodeCos = cosine(decoded, refDecoded)
            let decodeMaxAbsDiff = MLX.max(MLX.abs(decoded - refDecoded)).item(Float.self)
            print("[decode cos]  \(String(format: "%.5f", decodeCos))  maxAbsDiff=\(String(format: "%.4f", decodeMaxAbsDiff))")

            print("")
            if encodeCos >= threshold && decodeCos >= threshold {
                print("✅ KONTEXT VAE MATCHES MFLUX (threshold=\(threshold))")
            } else {
                print("❌ Kontext VAE diverges from Python "
                      + "(encode cos=\(String(format: "%.5f", encodeCos)), decode cos=\(String(format: "%.5f", decodeCos)), threshold=\(threshold))")
                throw ExitCode.failure
            }
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            return (dot / (na * nb + 1e-12)).item(Float.self)
        }
    }
}
