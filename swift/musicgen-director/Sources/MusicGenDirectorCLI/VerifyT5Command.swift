//
//  VerifyT5Command.swift
//  MusicGenDirectorCLI
//
//  `musicgen verify-t5` — numeric parity of MusicGenT5Encoder (loaded from
//  the flat checkpoint produced by run.py import-musicgen) against
//  gen_musicgen_t5_ref.py's real-weight, real-tokenizer Python output.
//

import ArgumentParser
import MusicGenDirector
import Foundation
import MLX

extension MusicGenCLI {
    struct VerifyT5: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-t5",
            abstract: "Compare Swift MusicGenT5Encoder against the real-weight Python reference (numeric parity)."
        )

        @Option(help: "text_encoder.safetensors from run.py import-musicgen.")
        var weights: String = "mlx-models/musicgen/musicgen-small/text_encoder.safetensors"

        @Option(help: "Reference safetensors from gen_musicgen_t5_ref.py.")
        var ref: String = "swift/musicgen-director/verify_refs/musicgen_t5_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("musicgen verify-t5 — T5-base text encoder numeric-parity checkpoint")

            let weightsURL = URL(fileURLWithPath: weights)
            guard FileManager.default.fileExists(atPath: weightsURL.path) else {
                print("ERROR: weights not found at \(weightsURL.path)")
                print("Run: python/venv/bin/python python/mlx-movie-director/run.py import-musicgen")
                throw ExitCode.failure
            }
            let t5Weights = try MusicGenT5Weights.load(path: weightsURL)
            print("loaded \(t5Weights.arrays.count) T5 weights, \(t5Weights.numBlocks) blocks")

            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it: python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)

            let encoder = MusicGenT5Encoder.build(weights: t5Weights, precision: .float32)

            let inputIds = refTensors["input_ids"]!.asType(.int32)
            let attentionMask = refTensors["attention_mask"]!.asType(.int32)
            let refEmbeds = refTensors["prompt_embeds"]!.asType(.float32)
            MLX.eval(inputIds, refEmbeds)

            let embeds = encoder(inputIds, attentionMask: attentionMask).asType(.float32)
            MLX.eval(embeds)
            print("swift hidden_states: \(embeds.shape)   ref: \(refEmbeds.shape)")
            let cos = cosine(embeds, refEmbeds)
            print("[hidden_states cos]  \(String(format: "%.5f", cos))")

            if cos >= threshold {
                print("\n✅ MUSICGEN T5 MATCHES PYTHON (threshold=\(threshold))")
            } else {
                print("\n❌ MusicGen T5 diverges (cos=\(String(format: "%.5f", cos)), threshold=\(threshold))")
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
