//
//  StyleCommand.swift
//  Flux2DirectorCLI
//
//  Phase 5: `flux2 style` — identity-preserving style transfer via reference
//  conditioning + style presets.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct Style: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "style",
            abstract: "Identity-preserving style transfer (anime↔real) via Flux2KleinEdit."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Input character image.")
        var input: String

        @Option(help: "Style preset: anime2real / real2anime / photorealistic / 3d-render.")
        var preset: String = "anime2real"

        @Option(help: "Override the style prompt (overrides preset).")
        var prompt: String = ""

        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 42
        @Option var width: Int = 832
        @Option var height: Int = 1216
        @Option var steps: Int = 0
        @Option var cfgScale: Float = 1.0
        @Option var refCount: Int = 0
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        @Flag var noArtifacts: Bool = false

        /// LoRA name(s) (directories under models/lora/), repeatable. Multiple
        /// are rank-stacked into one merged adapter (see Flux2LoRALoader.merge).
        /// Empty = no LoRA (prompt-only bias).
        @Option(help: "LoRA name under models/lora/ (repeatable: --lora A --lora B stacks them).")
        var lora: [String] = []
        @Option(help: "Per-LoRA scale (repeatable, one per --lora; trailing ones default to 1.0).")
        var loraScale: [Float] = []

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()
            guard let p = Flux2Style.presets[preset] else {
                throw ValidationError("unknown preset '\(preset)'. Available: \(Flux2Style.presets.keys.sorted().joined(separator: ", "))")
            }
            let stylePrompt = prompt.isEmpty ? p.prompt : prompt
            let useSteps = steps > 0 ? steps : p.steps
            let useRef = refCount > 0 ? Flux2Angle.clampRefCount(refCount) : p.refCount

            print("flux2 style — identity-preserving style transfer")
            print("  input    : \(input)")
            print("  preset   : \(preset)  (steps=\(useSteps), ref_count=×\(useRef))")
            print("  prompt   : \(stylePrompt)")
            print("  size     : \(width)×\(height), seed: \(seed)")

            let inputURL = URL(fileURLWithPath: input)
            let refPaths = Array(repeating: inputURL, count: useRef)

            // Load + merge LoRA adapters (optional, stackable). Each --lora name
            // resolves to one .safetensors under models/lora/<name>/; multiple are
            // rank-stacked into a single merged adapter (Flux2LoRALoader.merge).
            let (loraAdapters, loraNames, _) = try Flux2LoRALoaderCLI.loadMerged(
                names: lora, scales: loraScale, logPrefix: "  lora     : ")
            if !loraNames.isEmpty {
                print("               merged \(loraAdapters.adapters.count) adapters from \(loraNames.count) LoRA(s)")
            }

            let tfW = try Flux2TransformerWeights.load(
                dir: ModelPaths.transformerRoot.appendingPathComponent(transformer))
            let tf = Flux2Transformer.build(weights: tfW, lora: loraAdapters)
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
                prompt: stylePrompt, imagePaths: refPaths, seed: seed,
                height: height, width: width, steps: useSteps, guidance: cfgScale)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            try Flux2T2IPipeline.saveImage(pixels, to: URL(fileURLWithPath: paths.png))
            print("")
            print("✅ generated \(URL(fileURLWithPath: paths.png).lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(paths.png)")
            if loraNames.isEmpty {
                print("   note: no LoRA loaded (prompt-only style bias).")
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
