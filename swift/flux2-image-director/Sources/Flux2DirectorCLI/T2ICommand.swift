//
//  T2ICommand.swift
//  Flux2DirectorCLI
//
//  `flux2 t2i` — text-to-image generation via native Swift MLX Flux2 Klein.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct T2I: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "t2i",
            abstract: "Generate an image from a text prompt (Flux2 Klein, native Swift MLX)."
        )

        @OptionGroup var globals: GlobalOptions
        @OptionGroup var outputOptions: OutputOptions

        @Option(help: "Text prompt.")
        var prompt: String

        @Option(help: "Transformer variant under models/transformer/.")
        var transformer: String = Flux2ModelRegistry.defaultTransformer

        @Option(help: "Random seed.")
        var seed: UInt64 = 42

        @Option(help: "Output image width (px).")
        var width: Int = 1024

        @Option(help: "Output image height (px).")
        var height: Int = 1024

        @Option(help: "Number of denoising steps.")
        var steps: Int = 4

        @Option(help: "Classifier-free guidance scale (1.0 = off, recommended for distilled Klein).")
        var cfgScale: Float = 1.0

        @Option(help: "Negative prompt (used only when cfg > 1.0).")
        var negativePrompt: String = " "

        @Option(help: "Output PNG path. Empty = auto timestamped name in output dir.")
        var output: String = ""

        @Option(help: "Output directory (default: ../video_generation__output, or MLX_OUTPUT_DIR).")
        var outputDir: String?

        @Option(help: "Custom base name (default: output_YYYYMMDD_HHMMSS).")
        var name: String?

        @Option(help: "VAE weights directory (under models/vae/).")
        var vae: String = Flux2ModelRegistry.defaultVAE

        @Option(help: "Text encoder directory (under models/text_encoder/).")
        var encoder: String = Flux2ModelRegistry.defaultTextEncoder

        @Option(help: "Tokenizer directory (under models/tokenizer/).")
        var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer

        @Flag(help: "Skip writing run.json + manifest.json sidecars.")
        var noArtifacts: Bool = false

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()
            print("flux2 t2i — Flux2 Klein 9B (native Swift MLX)")
            print("  transformer : \(transformer)")
            print("  prompt      : \(prompt)")
            print("  size        : \(width)×\(height), steps: \(steps), cfg: \(cfgScale), seed: \(seed)")

            // 1. Load all model components.
            print("  loading models...")
            let tfURL = ModelPaths.transformerRoot.appendingPathComponent(transformer)
            let tfWeights = try Flux2TransformerWeights.load(dir: tfURL)
            let transformerModel = Flux2Transformer.build(weights: tfWeights)

            let teURL = ModelPaths.textEncoderRoot.appendingPathComponent(encoder)
            let teWeights = try Flux2TextEncoderWeights.load(dir: teURL)
            let textEncoderModel = Flux2TextEncoder.build(weights: teWeights)

            let tokURL = ModelPaths.tokenizerRoot.appendingPathComponent(tokenizerDir)
                .appendingPathComponent("tokenizer.json")
            let tokenizerModel = Flux2Tokenizer(jsonURL: tokURL)!

            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(vae)
            let vaeWeights = try loadAllShards(url: vaeURL)
            let vaeDecoder = Flux2VAEDecoder(weights: vaeWeights)
            let bn = Flux2BatchNormStats(
                runningMean: vaeWeights["bn.running_mean"]!,
                runningVar: vaeWeights["bn.running_var"]!)

            let pipeline = Flux2T2IPipeline(
                transformer: transformerModel, textEncoder: textEncoderModel,
                tokenizer: tokenizerModel, vaeDecoder: vaeDecoder, bn: bn)

            // 2. Run generation.
            print("  generating...")
            let (pixels, elapsed) = pipeline.generate(
                prompt: prompt, negativePrompt: negativePrompt,
                seed: seed, height: height, width: width,
                steps: steps, guidance: cfgScale)

            // 3. Save image.
            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            let imagePath = URL(fileURLWithPath: paths.png)
            try Flux2T2IPipeline.saveImage(pixels, to: imagePath)
            print("")
            print("✅ generated \(imagePath.lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(imagePath.path)")

            // 4. Write audit sidecars.
            if !noArtifacts {
                try writeArtifacts(pixels: pixels, elapsed: elapsed)
            }
        }

        private func writeArtifacts(pixels: MLXArray, elapsed: Double) throws {
            let startTime = Manifest.nowISO()
            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            let runConfig = RunConfig(
                transformer: transformer, prompt: prompt,
                width: width, height: height,
                steps: steps, seed: seed, cfgScale: cfgScale,
                loraPaths: nil, loraScale: 1.0,
                textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                quantBits: 8, quantGroupSize: 64,
                command: "t2i", pipeline: "flux2"
            )
            try runConfig.write(to: paths.runJSON)
            let sizeBytes = (try? FileManager.default.attributesOfItem(
                atPath: paths.png)[.size] as? Int64) ?? 0
            let manifest = Manifest.success(
                runFile: paths.runJSON, startTime: startTime, endTime: Manifest.nowISO(),
                timings: ["generation": elapsed], models: [:],
                outputFiles: [ManifestOutput(path: URL(fileURLWithPath: paths.png).lastPathComponent,
                                             seed: Int(seed), sizeBytes: sizeBytes,
                                             width: width, height: height)],
                quality: nil, perf: nil)
            try manifest.write(to: paths.manifestJSON)
            print("   run.json:   \(paths.runJSON)")
            print("   manifest:   \(paths.manifestJSON)")
        }

        private func loadAllShards(url: URL) throws -> [String: MLXArray] {
            var all: [String: MLXArray] = [:]
            let files = (try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil))
                .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for f in files {
                let shard = try loadArrays(url: f)
                all.merge(shard) { _, new in new }
            }
            return all
        }
    }
}
