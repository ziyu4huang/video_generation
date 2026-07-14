//
//  VerifyKontextTransformerCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-kontext-transformer` — kontext epic phase 2 NUMERIC parity
//  checkpoint (see output/next-goal-20260714_063909.md). Unlike
//  `verify-kontext-transformer-shape` (random weights, shape-only), this
//  loads the REAL FLUX.1-Kontext-dev checkpoint from the local HF cache and
//  compares against `gen_kontext_transformer_ref.py`'s real-weight, real-math
//  Python output (cos > threshold). This is the check the self-reflection in
//  the epic doc said this port still needed before being trusted.
//

import ArgumentParser
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct VerifyKontextTransformer: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-kontext-transformer",
            abstract: "Compare Swift KontextTransformer against real-weight Python mflux reference (numeric parity)."
        )

        @Option(help: "Directory containing the raw HF transformer/*.safetensors shards.")
        var transformerDir: String = NSString(string:
            "~/.cache/huggingface/hub/models--black-forest-labs--FLUX.1-Kontext-dev/snapshots"
        ).expandingTildeInPath

        @Option(help: "Reference safetensors from gen_kontext_transformer_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/kontext_transformer_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 verify-kontext-transformer — kontext epic phase 2 numeric-parity checkpoint")

            let tfDir = try resolveSnapshotTransformerDir(transformerDir)
            print("transformer dir: \(tfDir.path)")
            let weights = try KontextTransformerWeights.load(dir: tfDir)
            print("loaded \(weights.arrays.count) real HF weights "
                  + "(\(weights.numJointBlocks) joint + \(weights.numSingleBlocks) single blocks)")
            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it first: python/venv/bin/python "
                      + "python/mlx-movie-director/app/tests/gen_kontext_transformer_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)
            print("loaded \(refTensors.count) reference tensors")

            // float32 throughout — isolates algorithm correctness from bf16
            // rounding at this pathologically extreme t=0 conditioning
            // magnitude (guidance*1000=2500). See KontextTransformer.build's
            // doc comment.
            let model = KontextTransformer.build(weights: weights, precision: .float32)

            let hiddenStates = refTensors["hidden_states"]!.asType(.float32)
            let promptEmbeds = refTensors["prompt_embeds"]!.asType(.float32)
            let pooledPromptEmbeds = refTensors["pooled_prompt_embeds"]!.asType(.float32)
            let timeStep = refTensors["time_step"]!.asType(.float32)
            let guidance = refTensors["guidance"]!.asType(.float32)
            // Matches gen_kontext_transformer_ref.py: no reference image, plain
            // generation-latent ids (leading id=0), 64x64 -> 16 tokens.
            let imageIds = KontextUtil.createGenerationImageIds(height: 64, width: 64)

            print("=== intermediate comparison ===")
            let inter = model.debugForward(timeStep: timeStep, guidance: guidance, hiddenStates: hiddenStates,
                                           promptEmbeds: promptEmbeds, pooledPromptEmbeds: pooledPromptEmbeds,
                                           imageIds: imageIds)
            for k in ["hidden_post_embed", "enc_post_embed", "temb", "rope_c0",
                      "jb0_norm_hidden", "jb0_norm_enc_hidden", "jb0_attn_out", "jb0_ctx_attn_out",
                      "jb0_gate_msa", "jb0_shift_mlp", "jb0_scale_mlp", "jb0_gate_mlp",
                      "jb0_h_post_res", "jb0_normh2mod", "jb0_ff_out",
                      "enc_after_jb0", "hidden_after_jb0", "enc_after_all_joint", "hidden_after_all_joint",
                      "combined_after_sb0", "combined_after_all_single"] {
                guard let swift = inter[k], let pyRef = refTensors[k] else { print("  [\(k)] (missing)"); continue }
                let s = swift.asType(.float32); let p = pyRef
                MLX.eval(s, p)
                let c = cosine(s, p)
                let ratio = (MLX.abs(s) / (MLX.abs(p) + 1e-6)).mean().item(Float.self)
                let maxAbsDiff = MLX.max(MLX.abs(s - p)).item(Float.self)
                print("  [\(k)] cos=\(String(format: "%.5f", c))  meanRatio=\(String(format: "%.4f", ratio)) "
                      + "maxAbsDiff=\(String(format: "%.4f", maxAbsDiff))  swift=\(s.shape) ref=\(p.shape)")
            }

            print("=== full forward ===")
            let out = model(timeStep: timeStep, guidance: guidance, hiddenStates: hiddenStates,
                            promptEmbeds: promptEmbeds, pooledPromptEmbeds: pooledPromptEmbeds,
                            imageIds: imageIds).asType(.float32)
            MLX.eval(out)

            let refOut = refTensors["output"]!
            MLX.eval(refOut)
            print("swift output: \(out.shape)   ref output: \(refOut.shape)")

            let cos = cosine(out, refOut)
            let diff = out - refOut
            let maxAbsDiff = MLX.max(MLX.abs(diff)).item(Float.self)
            let meanAbsDiff = MLX.mean(MLX.abs(diff)).item(Float.self)
            let meanRef = MLX.mean(MLX.abs(refOut)).item(Float.self)

            print("")
            print("[cos]  \(String(format: "%.5f", cos))")
            print("[diff] max=\(String(format: "%.4f", maxAbsDiff)) mean=\(String(format: "%.5f", meanAbsDiff))  "
                  + "(ref mean|val|=\(String(format: "%.3f", meanRef)))")
            print("")
            if cos >= threshold {
                print("✅ KONTEXT TRANSFORMER MATCHES MFLUX (threshold=\(threshold))")
            } else {
                print("❌ KontextTransformer diverges from Python (cos=\(String(format: "%.5f", cos)) < \(threshold))")
                throw ExitCode.failure
            }
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            return (dot / (na * nb + 1e-12)).item(Float.self)
        }

        /// The HF snapshot dir is content-hash-named (unknown ahead of time).
        /// If `path` itself has transformer shards, use it as-is; otherwise
        /// treat it as a `.../snapshots` dir and look one level down for
        /// `<hash>/transformer/`.
        private func resolveSnapshotTransformerDir(_ path: String) throws -> URL {
            let fm = FileManager.default
            let direct = URL(fileURLWithPath: path)
            if (try? fm.contentsOfDirectory(atPath: direct.path))?.contains(where: { $0.hasSuffix(".safetensors") }) == true {
                return direct
            }
            guard let entries = try? fm.contentsOfDirectory(atPath: direct.path) else {
                print("ERROR: cannot list \(direct.path)")
                throw ExitCode.failure
            }
            for entry in entries {
                let candidate = direct.appendingPathComponent(entry).appendingPathComponent("transformer")
                if fm.fileExists(atPath: candidate.path) {
                    return candidate
                }
            }
            print("ERROR: no transformer/ subdir found under \(direct.path)")
            throw ExitCode.failure
        }
    }
}
