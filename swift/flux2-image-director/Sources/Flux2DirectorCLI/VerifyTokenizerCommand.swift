//
//  VerifyTokenizerCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-tokenizer` — Phase 2.2 checkpoint. Tokenizes a test prompt
//  with the Swift Flux2Tokenizer and compares token IDs against the Python
//  HuggingFace reference (chat template + BPE).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct VerifyTokenizer: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-tokenizer",
            abstract: "Compare Swift Flux2 tokenizer output against Python reference."
        )

        @Option(help: "Tokenizer directory (under models/tokenizer/).")
        var tokenizer: String = "qwen3-klein"

        @Option(help: "Reference safetensors from gen_flux2_encoder_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/flux2_encoder_ref.safetensors"

        func run() throws {
            print("flux2 verify-tokenizer — Phase 2.2 checkpoint")
            let tokURL = ModelPaths.tokenizerRoot.appendingPathComponent(tokenizer)
                .appendingPathComponent("tokenizer.json")
            var tok = Flux2Tokenizer(jsonURL: tokURL)!
            print("loaded tokenizer: \(tok.vocabCount) vocab entries")

            let ref = try loadArrays(url: URL(fileURLWithPath: ref))
            let refIds = ref["input_ids"]![0].asType(.int32)
            MLX.eval(refIds)
            let refIdArr: [Int32] = refIds.map { $0.item(Int32.self) }
            let refIdInts = refIdArr.map { Int($0) }

            // The reference prompt (hardcoded in gen_flux2_encoder_ref.py).
            let prompt = "a woman in a garden, professional photo, sharp focus"
            let (swiftIds, swiftMask) = tok.tokenize(prompt, maxLength: 512)

            print("prompt: \(prompt)")
            print("swift: \(swiftIds.count) tokens, ref: \(refIdInts.count) tokens")

            // Compare token-by-token.
            var mismatches = 0
            let compareCount = min(swiftIds.count, refIdInts.count)
            for i in 0..<compareCount where swiftIds[i] != refIdInts[i] {
                if mismatches < 10 {
                    print("  pos \(i): swift=\(swiftIds[i]) py=\(refIdInts[i])")
                }
                mismatches += 1
            }
            let matchPct = Double(compareCount - mismatches) / Double(compareCount) * 100
            print("match: \(compareCount - mismatches)/\(compareCount) (\(String(format: "%.1f", matchPct))%)")

            // Also verify attention_mask matches.
            let refMask = ref["attention_mask"]![0].asType(.int32)
            MLX.eval(refMask)
            let refMaskArr: [Int32] = refMask.map { $0.item(Int32.self) }
            var maskMismatch = 0
            for i in 0..<min(swiftMask.count, refMaskArr.count) where swiftMask[i] != Int(refMaskArr[i]) {
                maskMismatch += 1
            }
            print("attention_mask match: \(swiftMask.count - maskMismatch)/\(swiftMask.count)")

            print("")
            if mismatches == 0 && maskMismatch == 0 {
                print("✅ FLUX2 TOKENIZER MATCHES PYTHON")
            } else {
                print("❌ \(mismatches) token + \(maskMismatch) mask mismatches")
            }
        }
    }
}
