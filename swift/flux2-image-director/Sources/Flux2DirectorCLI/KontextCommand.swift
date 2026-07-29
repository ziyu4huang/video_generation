//
//  KontextCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 kontext` — in-context generation via FLUX.1-Kontext-dev (identity-
//  anchored single hero image + prompt). Distinct model family from Flux2
//  Klein — own transformer/CLIP/T5, shared VAE loader (ZImageVAEEncoder/
//  Decoder, converted separately via convert.py --kontext-vae-mlx).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX
import ZImageDirector

extension Flux2CLI {
    struct Kontext: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "kontext",
            abstract: "In-context generation via FLUX.1-Kontext-dev (identity-anchored hero image + prompt)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Hero / identity-anchor image path.")
        var input: String

        @Option(help: "In-context instruction prompt.")
        var prompt: String

        @Option(help: "Transformer directory under models/transformer/.")
        var transformer: String = "kontext-dev"

        @Option(help: "CLIP text-encoder directory under models/text_encoder/.")
        var clipEncoder: String = "kontext-dev-clip"

        @Option(help: "T5 text-encoder directory under models/text_encoder/.")
        var t5Encoder: String = "kontext-dev-t5"

        @Option(help: "VAE weights directory under models/vae/.")
        var vae: String = "flux-kontext-ae"

        @Option(help: "CLIP tokenizer directory under models/tokenizer/.")
        var clipTokenizerDir: String = "kontext-dev-clip-tok"

        @Option(help: "T5 tokenizer directory under models/tokenizer/.")
        var t5TokenizerDir: String = "kontext-dev-t5-tok"

        @Option(help: "Random seed.")
        var seed: UInt64 = 42

        @Option(help: "Output image width (px).")
        var width: Int = 1024

        @Option(help: "Output image height (px).")
        var height: Int = 1024

        @Option(help: "Number of denoising steps.")
        var steps: Int = 20

        @Option(help: "CFG-distilled guidance embedding value.")
        var guidance: Float = 2.5

        @Option(help: "Output PNG path. Empty = auto timestamped name in output dir.")
        var output: String = ""

        @Option(help: "Output directory (default: ../video_generation__output, or MLX_OUTPUT_DIR).")
        var outputDir: String?

        @Option(help: "Custom base name (default: output_YYYYMMDD_HHMMSS).")
        var name: String?

        @Flag(help: "Skip writing run.json + manifest.json sidecars.")
        var noArtifacts: Bool = false

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()
            print("flux2 kontext — FLUX.1-Kontext-dev (native Swift MLX)")
            print("  hero        : \(input)")
            print("  prompt      : \(prompt)")
            print("  size        : \(width)×\(height), steps: \(steps), guidance: \(guidance), seed: \(seed)")

            print("  loading models...")
            let tfWeights = try KontextTransformerWeights.load(
                dir: ModelPaths.transformerRoot.appendingPathComponent(transformer))
            let transformerModel = KontextTransformer.build(weights: tfWeights)

            let clipWeights = try KontextCLIPWeights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent(clipEncoder))
            let clipModel = KontextCLIPEncoder.build(weights: clipWeights)

            let t5Weights = try KontextT5Weights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent(t5Encoder))
            let t5Model = KontextT5Encoder.build(weights: t5Weights)

            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(vae).appendingPathComponent("model.safetensors")
            let vaeWeights = try loadArrays(url: vaeURL)
            let vaeEnc = ZImageVAEEncoder(weights: vaeWeights)
            let vaeDec = ZImageVAEDecoder(weights: vaeWeights)

            guard let clipTok = KontextCLIPTokenizer(
                vocabURL: ModelPaths.tokenizerRoot.appendingPathComponent(clipTokenizerDir).appendingPathComponent("vocab.json"),
                mergesURL: ModelPaths.tokenizerRoot.appendingPathComponent(clipTokenizerDir).appendingPathComponent("merges.txt")
            ) else {
                throw ValidationError("could not load CLIP tokenizer from \(clipTokenizerDir)")
            }
            guard let t5Tok = KontextT5Tokenizer(
                tokenizerJSONURL: ModelPaths.tokenizerRoot.appendingPathComponent(t5TokenizerDir).appendingPathComponent("tokenizer.json")
            ) else {
                throw ValidationError("could not load T5 tokenizer from \(t5TokenizerDir)")
            }

            let pipeline = KontextPipeline(
                transformer: transformerModel, clipEncoder: clipModel, t5Encoder: t5Model,
                vaeEncoder: vaeEnc, vaeDecoder: vaeDec, clipTokenizer: clipTok, t5Tokenizer: t5Tok)

            print("  generating...")
            let (pixels, elapsed) = pipeline.generate(
                prompt: prompt, heroImagePath: URL(fileURLWithPath: input), seed: seed,
                width: width, height: height, steps: steps, guidance: guidance)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            let imagePath = URL(fileURLWithPath: paths.png)
            try KontextPipeline.saveImage(pixels, to: imagePath)
            print("")
            print("✅ generated \(imagePath.lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(imagePath.path)")

            if !noArtifacts {
                try writeArtifacts(paths: paths, elapsed: elapsed)
            }
        }

        private func writeArtifacts(paths: OutputPaths, elapsed: Double) throws {
            let startTime = Manifest.nowISO()
            let runConfig = RunConfig(
                transformer: transformer, prompt: prompt,
                width: width, height: height, steps: steps, seed: seed, cfgScale: guidance,
                loraPaths: nil, loraScale: 1.0,
                textEncoder: t5Encoder, tokenizer: t5TokenizerDir, vae: vae,
                quantBits: 16, quantGroupSize: 64, command: "kontext", pipeline: "kontext"
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
    }
}
