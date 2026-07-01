//
//  VerifyE2ECommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-e2e` — Phase 2.4 checkpoint. Runs the full denoise loop and
//  compares the final packed latent + prompt_embeds against the Python reference.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct VerifyE2E: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-e2e",
            abstract: "Compare Swift Flux2 full denoise loop (final latent) against Python mflux."
        )

        @Option var transformer: String = "klein-9b"
        @Option var encoder: String = "qwen3-8b"
        @Option var tokenizerDir: String = "qwen3-klein"
        @Option(help: "Reference from gen_flux2_e2e_ref.py.")
        var ref: String = "swift/flux2-image-director/verify_refs/flux2_e2e_latent_ref.safetensors"
        @Option var threshold: Float = 0.98

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 verify-e2e — Phase 2.4 checkpoint")
            // Load models.
            let tfW = try Flux2TransformerWeights.load(
                dir: ModelPaths.transformerRoot.appendingPathComponent(transformer))
            let tf = Flux2Transformer.build(weights: tfW)
            let teW = try Flux2TextEncoderWeights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent(encoder))
            let te = Flux2TextEncoder.build(weights: teW)
            var tok = Flux2Tokenizer(jsonURL: ModelPaths.tokenizerRoot
                .appendingPathComponent(tokenizerDir).appendingPathComponent("tokenizer.json"))!

            let ref = try loadArrays(url: URL(fileURLWithPath: ref))

            // Prompt embeds (re-derive in Swift, compare to ref).
            let prompt = "a woman in a garden, professional photo"
            let (ids, mask) = tok.tokenize(prompt, maxLength: 512)
            let pe = te.getPromptEmbeds(
                MLXArray(ids.map { Int32($0) }).reshaped([1, -1]),
                attentionMask: MLXArray(mask.map { Int32($0) }).reshaped([1, -1]),
                hiddenStateLayers: [9, 18, 27]).asType(.bfloat16)
            MLX.eval(pe)
            let peCos = cosine(pe.asType(.float32), ref["prompt_embeds"]!)
            print("  prompt_embeds cos=\(String(format: "%.5f", peCos))")
            var checks: [VerifyCheck] = [VerifyCheck(
                name: "prompt_embeds", pass: true, cosine: Double(peCos), threshold: nil,
                detail: "diagnostic (re-derived in Swift)")]

            // Initial latents.
            let (latents, latentIds, latentH, latentW) = Flux2LatentCreator.preparePackedLatents(
                seed: 777, height: 512, width: 512)
            let textIds = Flux2LatentCreator.prepareTextIds(seqLen: pe.dim(1), batchSize: 1)
            let sched = Flux2Scheduler(imageSeqLen: 1024, numInferenceSteps: 4)

            var cur = latents
            for t in 0..<4 {
                let ts = sched.timesteps[t].asType(.bfloat16).reshaped([1])
                let noise = tf(hiddenStates: cur, encoderHiddenStates: pe,
                               timestep: ts, imgIds: latentIds, txtIds: textIds)
                cur = sched.step(noise: noise, timestep: t, latents: cur)
                MLX.eval(cur)
                print("  step \(t): latent sum=\(String(format: "%.3f", cur.sum().item(Float.self)))")
            }

            let cos = cosine(cur.asType(.float32), ref["final_latent"]!)
            print("")
            print("[final latent] cos=\(String(format: "%.5f", cos))  swift=\(cur.shape) ref=\(ref["final_latent"]!.shape)")
            if cos >= threshold {
                print("✅ FLUX2 E2E DENOISE MATCHES MFLUX (threshold=\(threshold))")
            } else {
                print("❌ e2e diverges (cos=\(String(format: "%.5f", cos)) < \(threshold))")
            }
            checks.append(VerifyCheck(name: "final_latent", pass: cos >= threshold, cosine: Double(cos),
                                      threshold: Double(threshold),
                                      detail: "4-step denoise, swift=\(cur.shape) ref=\(ref["final_latent"]!.shape)"))
            VerifyReport.write(VerifySummary(
                app: VerifyReport.app, command: "verify-e2e",
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
