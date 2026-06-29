//
//  AngleCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 angle` — multi-angle consistent character generation. Takes an input
//  character image + camera angle, generates a new view preserving identity via
//  Flux2KleinEdit multi-reference conditioning.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct Angle: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "angle",
            abstract: "Multi-angle consistent character view (Flux2KleinEdit multi-ref)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Input character image (identity reference).")
        var input: String

        @Option(help: "Optional identity/description prompt (default: identity-preservation template).")
        var prompt: String = ""

        @Option(help: "Named camera-angle preset: front/front-right/right/rear-right/back/rear-left/left/front-left, front-high/right-high/back-high/front-low/right-low, birds-eye/worms-eye.")
        var angle: String?

        @Option(help: "Azimuth degrees (overrides preset). 0=front, 90=right, 180=back.")
        var azimuth: Float?

        @Option(help: "Elevation degrees (overrides preset). >0=high-angle, <0=low-angle.")
        var elevation: Float?

        @Option(help: "Reference count (1-3; 3 = best identity fidelity).")
        var refCount: Int = 3

        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 42
        @Option var width: Int = 832
        @Option var height: Int = 1216
        @Option var steps: Int = 6
        @Option var cfgScale: Float = 1.0
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        @Flag var noArtifacts: Bool = false

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()
            let resolved = Flux2Angle.resolve(preset: angle, azimuth: azimuth, elevation: elevation)
            let refN = Flux2Angle.clampRefCount(refCount)
            let angleText = Flux2Angle.angleText(azimuth: resolved.azimuth, elevation: resolved.elevation)
            let fullPrompt = Flux2Angle.buildPrompt(
                userPrompt: prompt.isEmpty ? nil : prompt, angleText: angleText)

            print("flux2 angle — multi-angle identity-consistent view")
            print("  input      : \(input)")
            print("  angle      : \(angle ?? "—")  → az=\(resolved.azimuth)° el=\(resolved.elevation)°")
            print("  angle_text : \(angleText)")
            print("  ref_count  : ×\(refN)  (identity conditioning)")
            print("  prompt     : \(fullPrompt)")
            print("  size       : \(width)×\(height), steps: \(steps), seed: \(seed)")

            let inputURL = URL(fileURLWithPath: input)
            let refPaths = Array(repeating: inputURL, count: refN)

            // Load models.
            let tfW = try Flux2TransformerWeights.load(
                dir: ModelPaths.transformerRoot.appendingPathComponent(transformer))
            let tf = Flux2Transformer.build(weights: tfW)
            let teW = try Flux2TextEncoderWeights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent(encoder))
            let te = Flux2TextEncoder.build(weights: teW)
            let tok = Flux2Tokenizer(jsonURL: ModelPaths.tokenizerRoot
                .appendingPathComponent(tokenizerDir).appendingPathComponent("tokenizer.json"))!
            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(vae)
            let vaeWeights = try loadAllShards(url: vaeURL)
            let bn = Flux2BatchNormStats(
                runningMean: vaeWeights["bn.running_mean"]!,
                runningVar: vaeWeights["bn.running_var"]!)
            let pipeline = Flux2EditPipeline(
                transformer: tf, textEncoder: te, tokenizer: tok,
                vaeEncoder: Flux2VAEEncoder(weights: vaeWeights),
                vaeDecoder: Flux2VAEDecoder(weights: vaeWeights), bn: bn)

            print("  generating...")
            let (pixels, elapsed) = pipeline.generate(
                prompt: fullPrompt, imagePaths: refPaths, seed: seed,
                height: height, width: width, steps: steps, guidance: cfgScale)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            try Flux2T2IPipeline.saveImage(pixels, to: URL(fileURLWithPath: paths.png))
            print("")
            print("✅ generated \(URL(fileURLWithPath: paths.png).lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(paths.png)")
            if !noArtifacts {
                let runConfig = RunConfig(
                    transformer: transformer, prompt: fullPrompt,
                    width: width, height: height, steps: steps, seed: seed, cfgScale: cfgScale,
                    loraPaths: nil, loraScale: 1.0,
                    textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                    quantBits: 8, quantGroupSize: 64, command: "angle", pipeline: "flux2")
                try runConfig.write(to: paths.runJSON)
                print("   run.json: \(paths.runJSON)")
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
