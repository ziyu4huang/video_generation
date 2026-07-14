//
//  VerifyKontextCLIPCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-kontext-clip` — kontext epic phase 4b NUMERIC parity
//  checkpoint (see output/next-goal-20260714_212213.md). Loads the raw HF
//  `text_encoder/*.safetensors` directly into `KontextCLIPEncoder` (identity
//  key mapping, no conversion step needed) and compares against
//  `gen_kontext_clip_ref.py`'s real-weight, real-tokenizer Python output
//  (cos > threshold). Uses the SAME input_ids as the Python reference (saved
//  alongside pooled_output) so tokenizer parity is not conflated with model
//  parity — the Swift CLIP/T5 BPE/SentencePiece tokenizers are a separate,
//  not-yet-ported concern (tracked for phase 5 CLI wiring).
//

import ArgumentParser
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct VerifyKontextCLIP: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-kontext-clip",
            abstract: "Compare Swift KontextCLIPEncoder (loaded from raw HF weights) against real-weight Python mflux reference (numeric parity)."
        )

        @Option(help: "Raw HF FLUX.1-Kontext-dev text_encoder/ directory.")
        var weights: String = "\(NSHomeDirectory())/.cache/huggingface/hub/models--black-forest-labs--FLUX.1-Kontext-dev/snapshots/24e9dedc4ef646698dc8eb4e18ae2cec3c9fea0d/text_encoder"

        @Option(help: "Reference safetensors from gen_kontext_clip_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/kontext_clip_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 verify-kontext-clip — kontext epic phase 4b numeric-parity checkpoint")

            let weightsURL = URL(fileURLWithPath: weights)
            guard FileManager.default.fileExists(atPath: weightsURL.path) else {
                print("ERROR: text_encoder/ weights not found at \(weightsURL.path)")
                throw ExitCode.failure
            }
            let clipWeights = try KontextCLIPWeights.load(dir: weightsURL)
            print("loaded \(clipWeights.arrays.count) raw HF CLIP weights")

            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it first: python/venv/bin/python "
                      + "python/mlx-movie-director/app/tests/gen_kontext_clip_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)
            print("loaded \(refTensors.count) reference tensors")

            let encoder = KontextCLIPEncoder.build(weights: clipWeights, precision: .float32)

            let inputIds = refTensors["input_ids"]!.asType(.int32)
            let refPooled = refTensors["pooled_output"]!.asType(.float32)
            MLX.eval(inputIds, refPooled)

            let pooled = encoder(inputIds).asType(.float32)
            MLX.eval(pooled)
            print("swift pooled_output: \(pooled.shape)   ref pooled_output: \(refPooled.shape)")
            let cos = cosine(pooled, refPooled)
            let maxAbsDiff = MLX.max(MLX.abs(pooled - refPooled)).item(Float.self)
            print("[pooled_output cos]  \(String(format: "%.5f", cos))  maxAbsDiff=\(String(format: "%.4f", maxAbsDiff))")

            print("")
            if cos >= threshold {
                print("✅ KONTEXT CLIP MATCHES MFLUX (threshold=\(threshold))")
            } else {
                print("❌ Kontext CLIP diverges from Python "
                      + "(cos=\(String(format: "%.5f", cos)), threshold=\(threshold))")
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
