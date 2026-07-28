//
//  VerifyDecoderStepCommand.swift
//  MusicGenDirectorCLI
//
//  `musicgen verify-decoder-step` — single deterministic greedy forward pass
//  (no sampling) through MusicGenDecoder vs the real Python reference.
//

import ArgumentParser
import MusicGenDirector
import Foundation
import MLX

extension MusicGenCLI {
    struct VerifyDecoderStep: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-decoder-step",
            abstract: "Compare Swift MusicGenDecoder's single-step logits against the real Python reference."
        )

        @Option(help: "decoder.safetensors from run.py import-musicgen.")
        var weights: String = "mlx-models/musicgen/musicgen-small/decoder.safetensors"

        @Option(help: "Reference safetensors from gen_musicgen_decoder_step_ref.py.")
        var ref: String = "swift/musicgen-director/verify_refs/musicgen_decoder_step_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("musicgen verify-decoder-step — LM decoder single-step logits numeric-parity checkpoint")

            let weightsURL = URL(fileURLWithPath: weights)
            guard FileManager.default.fileExists(atPath: weightsURL.path) else {
                print("ERROR: weights not found at \(weightsURL.path)")
                print("Run: python/venv/bin/python python/mlx-movie-director/run.py import-musicgen")
                throw ExitCode.failure
            }

            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it: python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_decoder_step_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)
            let inputIds = refTensors["input_ids"]!.asType(.int32)
            let encoderHidden = refTensors["encoder_hidden_states"]!.asType(.float32)
            let refLastLogits = refTensors["last_logits"]!.asType(.float32)
            MLX.eval(inputIds, encoderHidden, refLastLogits)

            let mgWeights = try MusicGenWeights.load(path: weightsURL)
            let decoder = try MusicGenDecoder.build(weights: mgWeights, precision: .float32)

            let logits = decoder(inputIds: inputIds, encoderHiddenStates: encoderHidden)   // (4, seqLen, 2048)
            let lastLogits = logits[0..., logits.dim(1) - 1, 0...]   // (4, 2048)
            MLX.eval(lastLogits)
            print("swift last_logits: \(lastLogits.shape)   ref: \(refLastLogits.shape)")

            let cos = cosine(lastLogits, refLastLogits)
            print("[last_logits cos]  \(String(format: "%.5f", cos))")

            if cos >= threshold {
                print("\n✅ MUSICGEN DECODER STEP MATCHES PYTHON (threshold=\(threshold))")
            } else {
                print("\n❌ MusicGen decoder step diverges (cos=\(String(format: "%.5f", cos)), threshold=\(threshold))")
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
