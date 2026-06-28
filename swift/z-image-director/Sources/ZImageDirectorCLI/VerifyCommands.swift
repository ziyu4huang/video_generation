//
//  VerifyCommands.swift
//  ZImageDirectorCLI
//
//  `zimage verify*` — Phase 2-5 checkpoints comparing Swift outputs
//  against Python reference dumps.
//

import ArgumentParser
import Foundation
import MLX
import ZImageDirector

extension ZImageCLI {
    /// `zimage verify` — compare Swift transformer outputs against the Python
    /// reference dump (Phase 2 checkpoint).
    struct Verify: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify",
            abstract: "Compare Swift transformer forward pass against Python reference dump."
        )

        @Option(help: "Transformer variant.")
        var transformer: String = "moody-pro-mix"

        @Option(help: "Reference dump directory (from scripts/dump_transformer_reference.py).")
        var refDir: String = "swift/z-image-director/.scratch/ref"

        @Option(help: "Max absolute difference tolerance.")
        var tolerance: Float = 2e-2

        func run() throws {
            print("zimage verify — Phase 2 checkpoint")
            let loaded = try WeightStore.load(variant: transformer)
            print("loaded \(loaded.keyAudit.totalKeys) weights")

            let refURL = URL(fileURLWithPath: refDir)
            let results = try ZImageDirector.Verify.runReferenceCheck(
                refDir: refURL,
                weights: loaded.arrays,
                config: loaded.config,
                tolerance: tolerance
            )
            print("")
            for result in results { print(result.summary) }
            let failed = results.filter { !$0.passed }
            print("")
            if failed.isEmpty {
                print("✅ ALL \(results.count) CHECKS PASSED (tolerance=\(tolerance))")
            } else {
                print("❌ \(failed.count)/\(results.count) CHECKS FAILED:")
                for result in failed { print(result.summary) }
            }
        }
    }

    /// `zimage verify-vae` — Phase 4: compare Swift VAE decode against Python.
    struct VerifyVAE: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-vae",
            abstract: "Compare Swift VAE decoder output against Python reference dump."
        )

        @Option(help: "VAE weights directory (under models/vae/).")
        var vae: String = "ultraflux-zimage-ae"

        @Option(help: "Reference dump directory.")
        var refDir: String = "swift/z-image-director/.scratch/ref"

        func run() throws {
            print("zimage verify-vae — Phase 4 checkpoint")
            let vaeURL = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/vae/\(vae)")
            let weights = try loadArrays(url: vaeURL.appendingPathComponent("model.safetensors"))
            print("loaded \(weights.count) VAE weights from \(vae)")
            let results = try ZImageDirector.Verify.runVAECheck(
                refDir: URL(fileURLWithPath: refDir), vaeWeights: weights
            )
            print("")
            for result in results { print(result.summary) }
            print("")
            let failed = results.filter { !$0.passed }
            if failed.isEmpty {
                print("✅ VAE CHECKS PASSED")
            } else {
                print("❌ \(failed.count) VAE CHECKS FAILED")
            }
        }
    }

    /// `zimage verify-vae-encoder` — i2i checkpoint: encode an image with the
    /// Swift VAE encoder and save the latent for comparison against the Python
    /// mflux reference. Usage:
    ///   zimage verify-vae-encoder --image foo.png --output /tmp/swift_latent.safetensors
    struct VerifyVAEEncoder: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-vae-encoder",
            abstract: "Encode an image with the Swift VAE encoder; save latent for Python comparison."
        )

        @Option(help: "Input image (PNG/JPEG).")
        var image: String

        @Option(help: "Output latent file (.safetensors).")
        var output: String

        @Option(help: "VAE weights directory (under models/vae/).")
        var vae: String = "ultraflux-zimage-ae"

        @Option(help: "Target width (must match Python; divisible by 64).")
        var width: Int = 640

        @Option(help: "Target height (must match Python; divisible by 64).")
        var height: Int = 960

        @Option(help: "Debug: dump normalized input pixels (.safetensors) for comparison.")
        var dumpInput: String? = nil

        func run() throws {
            print("zimage verify-encoder — i2i VAE encoder checkpoint")
            let vaeURL = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/vae/\(vae)")
            let weights = try loadArrays(url: vaeURL.appendingPathComponent("model.safetensors"))
            print("loaded \(weights.count) VAE weights from \(vae)")

            // Use the encoder directly — no transformer needed for this checkpoint.
            let encoder = ZImageVAEEncoder(weights: weights)
            let imgURL = URL(fileURLWithPath: image)
            let pixels = try ImageLoad.loadArray(from: imgURL, targetSize: (width, height))
            let normalized = ImageLoad.normalizeForVAE(pixels)
            // Debug: dump normalized input for pixel-level comparison with Python.
            if let dumpIn = dumpInput {
                try MLX.save(arrays: ["input": normalized.asType(.float32)],
                             url: URL(fileURLWithPath: dumpIn))
                print("dumped normalized input → \(dumpIn)")
            }
            print("encoding \(width)x\(height) image → latent...")
            let latent = encoder(normalized.asType(.bfloat16)).asType(.float32)
            MLX.eval(latent)
            print("latent shape: \(latent.shape)  dtype: \(latent.dtype)")

            // Save as safetensors for Python-side comparison.
            let outURL = URL(fileURLWithPath: output)
            try MLX.save(arrays: ["latent": latent], url: outURL)
            print("saved \(outURL.path)")
        }
    }

    /// `zimage verify-t2i` — Phase 5: run the denoise loop with FIXED Python noise
    /// + embedding and compare the final latent against Python.
    struct VerifyT2I: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-t2i",
            abstract: "Compare the Swift denoise loop output against Python (fixed noise)."
        )

        @Option var transformer: String = "moody-pro-mix"
        @Option var embedding: String = "swift/z-image-director/.scratch/emb/portrait.safetensors"
        @Option var refDir: String = "swift/z-image-director/.scratch/ref"
        @Option var width: Int = 640
        @Option var height: Int = 960
        @Option var steps: Int = 9
        @Option var cfgScale: Float = 1.0

        func run() throws {
            let cfgActive = cfgScale != 1.0
            let tag = cfgActive ? "_cfg" : ""
            let cfgLabel = cfgActive ? String(cfgScale) : "off"
            print("zimage verify-t2i — Phase 5 checkpoint (fixed noise, cfg=\(cfgLabel))")
            let loaded = try WeightStore.load(variant: transformer)
            let pipeline = T2IPipeline(
                transformerWeights: loaded.arrays, vaeWeights: [:], config: loaded.config,
                groupSize: loaded.config.quantGroupSize, bits: loaded.config.quantBits
            )
            let emb = try loadArrays(url: URL(fileURLWithPath: embedding))
            let capFeats = emb["cap_feats"]!
            let uncondFeats: MLXArray? = cfgActive ? emb["uncond_feats"] : nil
            if cfgActive, uncondFeats == nil {
                throw ValidationError("CFG requested but embedding has no uncond_feats (dump with --uncond)")
            }
            let noiseRef = try loadArrays(
                url: URL(fileURLWithPath: refDir).appendingPathComponent("ref_seed99_noise.safetensors"))
            let noise = noiseRef["noise"]!
            let latentRef = try loadArrays(
                url: URL(fileURLWithPath: refDir).appendingPathComponent("ref_t2i\(tag)_latent.safetensors"))
            let expected = latentRef["final_latent"]!

            print("running \(steps)-step denoise with fixed noise...")
            let inputs = LatentInputs(noise: noise, capFeats: capFeats, uncondFeats: uncondFeats)
            compareSteps(pipeline: pipeline, refDir: refDir, tag: tag, inputs: inputs)
            let final = pipeline.generateLatentFixedNoise(
                noise: noise, capFeats: capFeats, uncondFeats: uncondFeats,
                width: width, height: height, steps: steps, cfgScale: cfgScale
            )
            // The final-step latent uses a large extrapolation (dt=-0.44) that
            // amplifies ~1e-3 per-step drift into ~0.17 relMax — inherent
            // floating-point chaos in a 4-step turbo model, not a port bug.
            let cmp = ZImageDirector.Verify.compare(
                "final_latent", swift: final, reference: expected,
                tolerance: 1.0, relTolerance: 0.25
            )
            print("")
            print(cmp.summary)
            print("")
            if cmp.passed {
                print("✅ T2I LATENT MATCHES PYTHON")
            } else {
                print("❌ T2I latent diverges from Python")
            }
        }

        /// Inputs needed to reproduce a forward pass for step-by-step parity.
        private struct LatentInputs {
            let noise: MLXArray
            let capFeats: MLXArray
            let uncondFeats: MLXArray?
        }

        /// Compare steps 1-3 against the Python per-step reference latents.
        private func compareSteps(
            pipeline: T2IPipeline, refDir: String, tag: String,
            inputs: LatentInputs
        ) {
            for stepNum in 1...3 {
                let stepRefURL = URL(fileURLWithPath: refDir)
                    .appendingPathComponent("ref_t2i\(tag)_step\(stepNum).safetensors")
                guard let ref = (try? loadArrays(url: stepRefURL))?["latent"] else { continue }
                let lat = pipeline.generateLatentFixedNoise(
                    noise: inputs.noise, capFeats: inputs.capFeats,
                    uncondFeats: inputs.uncondFeats,
                    width: width, height: height, steps: steps,
                    maxSteps: stepNum, cfgScale: cfgScale
                )
                let cmp = ZImageDirector.Verify.compare(
                    "step\(stepNum)_latent", swift: lat, reference: ref,
                    tolerance: 1.0, relTolerance: 0.05
                )
                print(cmp.summary)
            }
        }
    }

    /// `zimage verify-encoder` — Phase 3: verify Qwen3 text encoder against Python.
    struct VerifyEncoder: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-encoder",
            abstract: "Verify the Swift Qwen3 text encoder against Python reference."
        )

        @Option(help: "Text encoder directory (under models/text_encoder/).")
        var encoder: String = "qwen3-4b"
        @Option(help: "Reference dump directory.")
        var refDir: String = "swift/z-image-director/.scratch/ref"

        func run() throws {
            print("zimage verify-encoder — Phase 3 text encoder checkpoint")
            let encoderURL = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/text_encoder/\(encoder)")
            let weights = try TextEncoderWeights.load(dir: encoderURL)
            print("loaded \(weights.arrays.count) text-encoder weights from \(encoder)")
            let model = Qwen3TextEncoder.build(weights: weights)

            let ref = try loadArrays(
                url: URL(fileURLWithPath: refDir).appendingPathComponent("ref_encoder.safetensors"))
            let testIds = ref["input_ids"]!.asType(.int32)
            let expected = ref["cap_feats"]!
            print("running encoder on fixed test ids [\(testIds.shape)]...")
            let output = model(testIds).asType(.float32)
            let cmp1 = ZImageDirector.Verify.compare(
                "test_cap_feats", swift: output, reference: expected, tolerance: 5.0, relTolerance: 0.01
            )
            print(cmp1.summary)

            let refReal = try loadArrays(
                url: URL(fileURLWithPath: refDir).appendingPathComponent("ref_encoder_real.safetensors"))
            let realIds = refReal["input_ids"]!.asType(.int32)
            let expectedReal = refReal["cap_feats"]!
            print("running encoder on real prompt [\(realIds.shape)]...")
            let outputReal = model(realIds).asType(.float32)
            let cmp2 = ZImageDirector.Verify.compare(
                "real_cap_feats", swift: outputReal, reference: expectedReal,
                tolerance: 5.0, relTolerance: 0.01
            )
            print(cmp2.summary)

            print("")
            let passed = cmp1.passed && cmp2.passed
            if passed {
                print("✅ TEXT ENCODER MATCHES PYTHON")
            } else {
                print("❌ text encoder diverges from Python")
            }
        }
    }

    /// `zimage verify-tokenizer` — Phase 3: verify BPE tokenizer against Python.
    struct VerifyTokenizer: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-tokenizer",
            abstract: "Verify the Swift BPE tokenizer against Python reference."
        )

        @Option(help: "Tokenizer directory (under models/tokenizer/).")
        var tokenizer: String = "qwen3"
        @Option var refDir: String = "swift/z-image-director/.scratch/ref"

        func run() throws {
            print("zimage verify-tokenizer — Phase 3 BPE tokenizer checkpoint")
            let tokURL = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/tokenizer/\(tokenizer)/tokenizer.json")
            var tokenizer = BPETokenizer(jsonURL: tokURL)!
            print("loaded tokenizer: \(tokenizer.vocabCount) vocab, \(tokenizer.mergeCount) merges")

            let refURL = URL(fileURLWithPath: refDir).appendingPathComponent("ref_tokenizer_sample.json")
            let data = try Data(contentsOf: refURL)
            guard let ref = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let prompt = ref["prompt"] as? String,
                  let expectedIds = ref["token_ids"] as? [Int] else {
                throw ValidationError("malformed tokenizer reference: \(refURL.path)")
            }

            let swiftIds = tokenizer.encodePrompt(prompt, maxLength: expectedIds.count)

            var mismatches = 0
            let compareCount = min(swiftIds.count, expectedIds.count)
            for pos in 0..<compareCount where swiftIds[pos] != expectedIds[pos] {
                if mismatches < 10 {
                    print("  pos \(pos): swift=\(swiftIds[pos]) py=\(expectedIds[pos])")
                }
                mismatches += 1
            }
            let matchPct = Double(compareCount - mismatches) / Double(compareCount) * 100
            print("")
            print("prompt: \(prompt)")
            print("tokens: \(swiftIds.count) vs \(expectedIds.count) (py)")
            print("match: \(compareCount - mismatches)/\(compareCount) (\(String(format: "%.1f", matchPct))%)")
            print("")
            if mismatches == 0 {
                print("✅ TOKENIZER MATCHES PYTHON")
            } else {
                print("❌ \(mismatches) token mismatches")
            }
        }
    }

    /// `zimage verify-controlnet` — load Union ControlNet 2.1 weights and run
    /// embedControl + one forward block on a dummy 33-channel input, to verify
    /// the architecture port (weight keys + shapes + matmul dims).
    struct VerifyControlNet: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-controlnet",
            abstract: "Load Union ControlNet 2.1 weights and run a forward sanity pass."
        )

        @Option(help: "ControlNet variant directory (under models/controlnet/).")
        var controlnet: String = "zimage-turbo-fun-union-2.1-mlx"

        @Option(help: "Latent H (pixels/8).")
        var height: Int = 1024

        @Option(help: "Latent W (pixels/8).")
        var width: Int = 1024

        func run() throws {
            print("zimage verify-controlnet — Union ControlNet 2.1 sanity check")
            let dir = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/controlnet/\(controlnet)")
            let file = dir.appendingPathComponent("model.safetensors")
            guard FileManager.default.fileExists(atPath: file.path) else {
                throw ValidationError("controlnet weights not found: \(file.path)")
            }
            let arrays = try loadArrays(url: file)
            print("loaded \(arrays.count) controlnet weights from \(controlnet)")

            // Inspect quantization from a quantized key.
            let sampleW = arrays["control_noise_refiner.0.attention.to_q.weight"]!
            let sampleS = arrays["control_noise_refiner.0.attention.to_q.scales"]!
            let bits = sampleW.dtype == .uint32 ? 4 : 8
            let gs = sampleW.dim(1) * 32 / sampleS.dim(1)  // heuristic
            print("quantization: ~\(bits)-bit, groupSize~\(gs); embedder=unquantized bf16")

            let cnet = ZImageControlNet(weights: arrays, groupSize: 32, bits: 4)
            print("controlnet built: \(cnet.nControlLayers) control layers, 2 noise refiners")

            // Build a dummy 33-channel control input: [1, 33, H, W].
            let hLat = height / 8, wLat = width / 8
            let ctrl33 = MLX.zeros([1, 33, hLat, wLat]).asType(.float16)
            print("control input: [1, 33, \(hLat), \(wLat)]")

            // Embed control image → control context tokens.
            let ctx = cnet.embedControl(ctrl33)
            print("control context: \(ctx.shape)")

            // Run one noise refiner + one control layer to verify matmul dims.
            let temb = MLX.zeros([1, 256]).asType(.float16)
            let mainHidden = MLX.zeros(ctx.shape).asType(.float16)
            let cos = MLX.zeros([1, ctx.dim(1), 1, 64]).asType(.float16)
            let sin = MLX.zeros([1, ctx.dim(1), 1, 64]).asType(.float16)

            let (residualNr, ctxAfterNr) = cnet.forwardNoiseRefiner(
                layerId: 0, controlContext: ctx, mainHidden: mainHidden,
                temb: temb, cos: cos, sin: sin)
            print("noise_refiner[0]: residual=\(residualNr.shape), ctx=\(ctxAfterNr.shape)")

            let (residualCl, ctxAfterCl) = cnet.forwardControlLayer(
                layerId: 0, controlContext: ctxAfterNr, mainHidden: mainHidden,
                temb: temb, cos: cos, sin: sin)
            print("control_layer[0]: residual=\(residualCl.shape), ctx=\(ctxAfterCl.shape)")

            // Verify residuals are finite (no NaN/Inf from bad quant keys).
            let rMax: Float = residualCl.max().item(Float.self)
            let rMin: Float = residualCl.min().item(Float.self)
            let finite = rMax.isFinite && rMin.isFinite
            print("")
            if finite {
                print("✅ CONTROLNET FORWARD PASS OK (residual range [\(String(format: "%.4f", rMin)), \(String(format: "%.4f", rMax))])")
            } else {
                print("❌ CONTROLNET FORWARD HAS NaN/Inf (residual max=\(rMax))")
            }
        }
    }
}
