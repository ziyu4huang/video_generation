//
//  KVStyleTransferCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 kv-style-transfer` — training-free K/V-injection style transfer
//  (V-AdaIN + per-frequency K-scale + Q/K-AdaIN), ported from the validated
//  krea2 mechanism. The genuine style-transfer path (vs Flux2Style.swift's
//  prompt-preset + KleinEdit). See Flux2KVStyleTransfer.swift for the gate.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct KVStyleTransfer: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "kv-style-transfer",
            abstract: "Training-free K/V-injection style transfer (krea2 mechanism port)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Text prompt (content + composition).") var prompt: String
        @Option(help: "Style reference image path (PNG/JPG).") var styleImage: String
        @Option(help: "Style strength 0..1 (0 = byte-identical to vanilla t2i at --seed).")
        var strength: Float = 1.0
        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 42
        @Option var width: Int = 1024
        @Option var height: Int = 1024
        @Option var steps: Int = 4
        @Option var cfgScale: Float = 1.0
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        // Style knobs (default to the ComfyUI-Krea2-StyleTransfer _RECOMMENDED preset).
        @Option var valueAdainStrength: Float = 0.65
        @Option var adainStrength: Float = 0.85
        @Option var refKStrength: Float = 1.06
        @Option var lowScaleEnd: Float = 1.10
        @Option var activeBlocksStart: Int = 7
        @Option var activeBlocksEnd: Int = 27
        @Flag var noArtifacts: Bool = false

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()
            print("flux2 kv-style-transfer — K/V-injection (krea2 mechanism port)")
            print("  prompt  : \(prompt)")
            print("  style   : \(styleImage)")
            print("  strength: \(strength), size: \(width)×\(height), steps: \(steps), seed: \(seed)")

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
            let vaeEnc = Flux2VAEEncoder(weights: vaeWeights)
            let vaeDec = Flux2VAEDecoder(weights: vaeWeights)
            let bn = Flux2BatchNormStats(
                runningMean: vaeWeights["bn.running_mean"]!,
                runningVar: vaeWeights["bn.running_var"]!)

            let pipeline = Flux2StyleTransferPipeline(
                transformer: tf, textEncoder: te, tokenizer: tok,
                vaeEncoder: vaeEnc, vaeDecoder: vaeDec, bn: bn)
            let knobs = Flux2StyleDefaults(
                valueAdainStrength: valueAdainStrength,
                refKStrength: refKStrength, lowScaleEnd: lowScaleEnd,
                adainStrength: adainStrength,
                activeBlocks: activeBlocksStart...activeBlocksEnd)

            print("  generating...")
            let (pixels, elapsed) = pipeline.generate(
                prompt: prompt, styleImage: URL(fileURLWithPath: styleImage),
                strength: strength, width: width, height: height, steps: steps,
                seed: seed, guidance: cfgScale, knobs: knobs)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            try Flux2T2IPipeline.saveImage(pixels, to: URL(fileURLWithPath: paths.png))
            print("")
            print("✅ styled \(URL(fileURLWithPath: paths.png).lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(paths.png)")
            if !noArtifacts {
                let runConfig = RunConfig(
                    transformer: transformer, prompt: prompt,
                    width: width, height: height, steps: steps, seed: seed, cfgScale: cfgScale,
                    loraPaths: nil, loraScale: 1.0,
                    textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                    quantBits: 8, quantGroupSize: 64, command: "kv-style-transfer", pipeline: "flux2")
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
