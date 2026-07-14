//
//  VerifyKontextT5Command.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-kontext-t5` — kontext epic phase 4b NUMERIC parity
//  checkpoint (see output/next-goal-20260714_212213.md). Loads the raw HF
//  `text_encoder_2/*.safetensors` shards directly into `KontextT5Encoder`
//  (identity key mapping except relative_attention_bias, broadcast from
//  block 0 — see KontextT5Encoder.swift's header) and compares against
//  `gen_kontext_t5_ref.py`'s real-weight, real-tokenizer Python output
//  (cos > threshold). Uses the SAME input_ids as the Python reference so
//  tokenizer parity is not conflated with model parity (Swift T5
//  SentencePiece tokenizer is a separate, not-yet-ported concern, tracked
//  for phase 5 CLI wiring).
//

import ArgumentParser
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct VerifyKontextT5: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-kontext-t5",
            abstract: "Compare Swift KontextT5Encoder (loaded from raw HF weights) against real-weight Python mflux reference (numeric parity)."
        )

        @Option(help: "Raw HF FLUX.1-Kontext-dev text_encoder_2/ directory.")
        var weights: String = "\(NSHomeDirectory())/.cache/huggingface/hub/models--black-forest-labs--FLUX.1-Kontext-dev/snapshots/24e9dedc4ef646698dc8eb4e18ae2cec3c9fea0d/text_encoder_2"

        @Option(help: "Reference safetensors from gen_kontext_t5_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/kontext_t5_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 verify-kontext-t5 — kontext epic phase 4b numeric-parity checkpoint")

            let weightsURL = URL(fileURLWithPath: weights)
            guard FileManager.default.fileExists(atPath: weightsURL.path) else {
                print("ERROR: text_encoder_2/ weights not found at \(weightsURL.path)")
                throw ExitCode.failure
            }
            let t5Weights = try KontextT5Weights.load(dir: weightsURL)
            print("loaded \(t5Weights.arrays.count) raw HF T5 weights, \(t5Weights.numBlocks) blocks")

            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it first: python/venv/bin/python "
                      + "python/mlx-movie-director/app/tests/gen_kontext_t5_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)
            print("loaded \(refTensors.count) reference tensors")

            let encoder = KontextT5Encoder.build(weights: t5Weights, precision: .float32)

            let inputIds = refTensors["input_ids"]!.asType(.int32)
            let refEmbeds = refTensors["prompt_embeds"]!.asType(.float32)
            MLX.eval(inputIds, refEmbeds)

            let embeds = encoder(inputIds).asType(.float32)
            MLX.eval(embeds)
            print("swift prompt_embeds: \(embeds.shape)   ref prompt_embeds: \(refEmbeds.shape)")
            let cos = cosine(embeds, refEmbeds)
            let maxAbsDiff = MLX.max(MLX.abs(embeds - refEmbeds)).item(Float.self)
            print("[prompt_embeds cos]  \(String(format: "%.5f", cos))  maxAbsDiff=\(String(format: "%.4f", maxAbsDiff))")

            print("")
            if cos >= threshold {
                print("✅ KONTEXT T5 MATCHES MFLUX (threshold=\(threshold))")
            } else {
                print("❌ Kontext T5 diverges from Python "
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
