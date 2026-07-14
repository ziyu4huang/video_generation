//
//  VerifyKontextTokenizerCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-kontext-clip-tokenizer` / `verify-kontext-t5-tokenizer` —
//  kontext epic phase 5 prerequisite (see
//  output/next-goal-20260714_223500.md). Compares Swift
//  `KontextCLIPTokenizer`/`KontextT5Tokenizer` against real HF tokenizer
//  output (`gen_kontext_tokenizer_ref.py`) EXACTLY, token-for-token — a
//  length-only match is not sufficient (the epic's established discipline:
//  don't round a partial check up to "done").
//

import ArgumentParser
import Flux2Director
import Foundation

private struct TokenizerRefItem: Decodable {
    let prompt: String
    let ids: [Int]
}

private struct TokenizerRef: Decodable {
    let clip: [TokenizerRefItem]
    let t5: [TokenizerRefItem]
}

extension Flux2CLI {
    struct VerifyKontextCLIPTokenizer: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-kontext-clip-tokenizer",
            abstract: "Compare Swift KontextCLIPTokenizer against real HF CLIPTokenizer output (exact token-id match)."
        )

        @Option(help: "CLIP tokenizer directory (vocab.json + merges.txt).")
        var tokenizerDir: String = "\(NSHomeDirectory())/.cache/huggingface/hub/models--black-forest-labs--FLUX.1-Kontext-dev/snapshots/24e9dedc4ef646698dc8eb4e18ae2cec3c9fea0d/tokenizer"

        @Option(help: "Reference JSON from gen_kontext_tokenizer_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/kontext_tokenizer_ref.json"

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 verify-kontext-clip-tokenizer — kontext epic phase 5 prerequisite")

            let dir = URL(fileURLWithPath: tokenizerDir)
            guard var tokenizer = KontextCLIPTokenizer(
                vocabURL: dir.appendingPathComponent("vocab.json"),
                mergesURL: dir.appendingPathComponent("merges.txt")
            ) else {
                print("ERROR: could not load CLIP tokenizer from \(dir.path)")
                throw ExitCode.failure
            }

            let refData = try Data(contentsOf: URL(fileURLWithPath: ref))
            let refs = try JSONDecoder().decode(TokenizerRef.self, from: refData)

            var allPass = true
            for item in refs.clip {
                let ids = tokenizer.tokenize(item.prompt)
                let pass = ids == item.ids
                allPass = allPass && pass
                print("\(pass ? "✅" : "❌") \(item.prompt.isEmpty ? "<empty>" : item.prompt)")
                if !pass {
                    print("   swift: \(ids)")
                    print("   ref:   \(item.ids)")
                }
            }

            print("")
            if allPass {
                print("✅ KONTEXT CLIP TOKENIZER MATCHES HF (exact token-id match, \(refs.clip.count) prompts)")
            } else {
                print("❌ Kontext CLIP tokenizer diverges from HF on at least one prompt")
                throw ExitCode.failure
            }
        }
    }

    struct VerifyKontextT5Tokenizer: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-kontext-t5-tokenizer",
            abstract: "Compare Swift KontextT5Tokenizer against real HF T5TokenizerFast output (exact token-id match)."
        )

        @Option(help: "T5 tokenizer.json path.")
        var tokenizerJSON: String = "\(NSHomeDirectory())/.cache/huggingface/hub/models--black-forest-labs--FLUX.1-Kontext-dev/snapshots/24e9dedc4ef646698dc8eb4e18ae2cec3c9fea0d/tokenizer_2/tokenizer.json"

        @Option(help: "Reference JSON from gen_kontext_tokenizer_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/kontext_tokenizer_ref.json"

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 verify-kontext-t5-tokenizer — kontext epic phase 5 prerequisite")

            guard let tokenizer = KontextT5Tokenizer(tokenizerJSONURL: URL(fileURLWithPath: tokenizerJSON)) else {
                print("ERROR: could not load T5 tokenizer from \(tokenizerJSON)")
                throw ExitCode.failure
            }

            let refData = try Data(contentsOf: URL(fileURLWithPath: ref))
            let refs = try JSONDecoder().decode(TokenizerRef.self, from: refData)

            var allPass = true
            for item in refs.t5 {
                let ids = tokenizer.tokenize(item.prompt, maxLength: item.ids.count)
                let pass = ids == item.ids
                allPass = allPass && pass
                print("\(pass ? "✅" : "❌") \(item.prompt.isEmpty ? "<empty>" : item.prompt)")
                if !pass {
                    print("   swift: \(ids)")
                    print("   ref:   \(item.ids)")
                }
            }

            print("")
            if allPass {
                print("✅ KONTEXT T5 TOKENIZER MATCHES HF (exact token-id match, \(refs.t5.count) prompts)")
            } else {
                print("❌ Kontext T5 tokenizer diverges from HF on at least one prompt")
                throw ExitCode.failure
            }
        }
    }
}
