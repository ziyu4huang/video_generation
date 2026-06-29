//
//  SwapCommand.swift
//  Flux2DirectorCLI
//
//  Phase 4.2: `flux2 swap` — replace an object in the source with a reference
//  image. Segments the source via SAM3, composites the reference into the mask
//  region (Swift, feathered alpha-blend), optionally harmonizes via KleinEdit.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct Swap: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "swap",
            abstract: "Replace an object (SAM3 mask) with a reference image."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Source image (the object here is replaced).")
        var source: String

        @Option(help: "Reference image (pasted into the mask region).")
        var reference: String

        @Option(help: "Text prompt describing the object to replace in the source.")
        var prompt: String

        @Option(help: "Detection score threshold.")
        var threshold: Float = 0.2

        @Option(help: "Feather radius for the composite edge (px).")
        var feather: Int = 10

        @Option(help: "Dilate the source mask by N px before compositing (expand the swap region). Default 0.")
        var maskDilate: Int = 0

        @Flag(help: "Preserve the reference's aspect ratio when fitting it into the mask (no stretch).")
        var preserveAspectRatio: Bool = false

        @Flag(help: "Seamless mode (无痕): regenerate the masked region via Flux2KleinEdit masked denoise (no paste seam). Uses --reference for identity. Overrides the feathered paste.")
        var inpaint: Bool = false

        @Flag(help: "After compositing, harmonize via Flux2KleinEdit (uses source as reference).")
        var harmonize: Bool = false

        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 42
        @Option var width: Int = 1024
        @Option var height: Int = 1024
        @Option var steps: Int = 4
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Flag var noArtifacts: Bool = false

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()
            print("flux2 swap — SAM3 mask + reference composite")
            print("  source    : \(source)")
            print("  reference : \(reference)")
            print("  prompt    : \(prompt)")

            // 1. Segment the source to get the mask.
            var repoRoot = FileManager.default.currentDirectoryPath
            for _ in 0..<8 {
                let p = (repoRoot as NSString).appendingPathComponent("python/venv/bin/python")
                if FileManager.default.isExecutableFile(atPath: p) { break }
                repoRoot = (repoRoot as NSString).deletingLastPathComponent
            }
            let maskPath = NSTemporaryDirectory() + "flux2_swap_mask_\(getpid()).png"
            try runSAM3Bridge(repoRoot: repoRoot, image: source, prompt: prompt,
                              threshold: threshold, outMask: maskPath)
            // Check detection count.
            let metaPath = maskPath + ".json"
            let meta = (try? Data(contentsOf: URL(fileURLWithPath: metaPath)))
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let count = meta["count"] as? Int ?? 0
            guard count > 0 else {
                print("⚠️  no detections for '\(prompt)' — nothing to swap.")
                return
            }
            print("  mask      : \(count) detection(s) → \(maskPath)")

            // 2. Load source + mask at the target size. Reference loaded only for
            //    the paste path (inpaint reads it via reference conditioning).
            let srcArr = try Flux2ImageLoad.loadArray(
                from: URL(fileURLWithPath: source), targetSize: (width: width, height: height))
            let maskArr = try Flux2ImageLoad.loadMaskAsChannel(
                from: URL(fileURLWithPath: maskPath), width: width, height: height)

            var pixels: MLXArray
            if inpaint {
                // Seamless (无痕): regenerate the masked region via Flux2KleinEdit
                // masked denoise — no paste seam. Reference supplies identity.
                print("  inpaint (seamless): regenerating masked region via Flux2KleinEdit...")
                let pipeline = try buildEditPipeline(transformer: transformer)
                let (img, elapsed) = pipeline.inpaint(
                    prompt: prompt, sourcePixels: srcArr, sourceMask: maskArr,
                    referencePath: URL(fileURLWithPath: reference),
                    seed: seed, steps: steps, guidance: 1.0,
                    width: width, height: height, feather: feather)
                pixels = img
                print("  inpaint done (\(String(format: "%.1f", elapsed))s)")
            } else {
                // Paste path: feathered composite (+ optional harmonize).
                let refArr = try Flux2ImageLoad.loadArray(
                    from: URL(fileURLWithPath: reference), targetSize: (width: width, height: height))
                pixels = Flux2Composite.composite(
                    source: srcArr, reference: refArr, mask: maskArr, featherRadius: feather,
                    preserveAspectRatio: preserveAspectRatio, maskDilate: maskDilate)
                MLX.eval(pixels)
                print("  composited (feather=\(feather), dilate=\(maskDilate), aspect=\(preserveAspectRatio))")

                if harmonize {
                    print("  harmonizing via Flux2KleinEdit...")
                    let harmPath = NSTemporaryDirectory() + "flux2_swap_src_\(getpid()).png"
                    try Flux2T2IPipeline.saveImage(pixels, to: URL(fileURLWithPath: harmPath))
                    let pipeline = try buildEditPipeline(transformer: transformer)
                    pixels = pipeline.generate(
                        prompt: prompt, imagePaths: [URL(fileURLWithPath: harmPath)],
                        seed: seed, height: height, width: width, steps: steps, guidance: 1.0).0
                }
            }

            // 5. Self-gate + save.
            try ImageGate.check(pixels, label: "swap", strict: false)
            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            try Flux2T2IPipeline.saveImage(pixels, to: URL(fileURLWithPath: paths.png))
            print("")
            print("✅ saved \(URL(fileURLWithPath: paths.png).lastPathComponent)")
            print("   \(paths.png)")
        }

        /// Build a Flux2KleinEdit pipeline (transformer + encoder + tokenizer + VAE).
        private func buildEditPipeline(transformer: String) throws -> Flux2EditPipeline {
            let tfW = try Flux2TransformerWeights.load(
                dir: ModelPaths.transformerRoot.appendingPathComponent(transformer))
            let tf = Flux2Transformer.build(weights: tfW)
            let teW = try Flux2TextEncoderWeights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent("qwen3-8b"))
            let te = Flux2TextEncoder.build(weights: teW)
            let tok = Flux2Tokenizer(jsonURL: ModelPaths.tokenizerRoot
                .appendingPathComponent("qwen3-klein").appendingPathComponent("tokenizer.json"))!
            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent("flux2-klein")
            let vaeWeights = try loadAllShards(url: vaeURL)
            let bn = Flux2BatchNormStats(
                runningMean: vaeWeights["bn.running_mean"]!,
                runningVar: vaeWeights["bn.running_var"]!)
            return Flux2EditPipeline(
                transformer: tf, textEncoder: te, tokenizer: tok,
                vaeEncoder: Flux2VAEEncoder(weights: vaeWeights),
                vaeDecoder: Flux2VAEDecoder(weights: vaeWeights), bn: bn)
        }

        private func runSAM3Bridge(repoRoot: String, image: String, prompt: String,
                                    threshold: Float, outMask: String) throws {
            let bridge = (repoRoot as NSString)
                .appendingPathComponent("python/mlx-movie-director/app/tests/sam3_segment_bridge.py")
            let python = (repoRoot as NSString).appendingPathComponent("python/venv/bin/python")
            let p = Process()
            p.executableURL = URL(fileURLWithPath: python)
            p.arguments = [bridge, "--image", image, "--prompt", prompt,
                           "--out-mask", outMask, "--threshold", String(threshold)]
            try p.run()
            p.waitUntilExit()
            if p.terminationStatus != 0 {
                throw NSError(domain: "swap", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "SAM3 bridge failed"])
            }
        }

        private func loadAllShards(url: URL) throws -> [String: MLXArray] {
            var all: [String: MLXArray] = [:]
            let files = (try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil))
                .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for f in files { all.merge(try loadArrays(url: f)) { _, new in new } }
            return all
        }
    }
}
