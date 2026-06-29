//
//  ExpandCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 expand` — outpaint / image expansion (擴圖). Extends an image beyond
//  its original borders via latent-mask re-injection: the original is centered on
//  a larger canvas (edge-replicated fill), and during denoising the kept region's
//  latent is forced back to its VAE-encoded value each step so the original
//  survives bit-for-bit, while the padded margins generate from the prompt.
//
//  Mirrors the ComfyUI "Flux2_Klein_Image expansion" workflow and the python
//  app/flux2_outpaint_pipeline.py. Canvas/mask construction = Flux2Outpaint;
//  the denoise loop = Flux2EditPipeline.outpaint.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct Expand: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "expand",
            abstract: "Outpaint / image expansion — extend borders (Flux2 latent-mask re-injection)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Input image to expand.")
        var input: String

        @Option(help: "Prompt describing content to fill the new margins (zh-TW supported).")
        var prompt: String

        @Option(help: "Expansion preset: 'all', a comma list (left,right,top,bottom), or an aspect ratio (16:9, 4:3, 3:2). Default 'all'.")
        var expand: String = "all"

        @Option(help: "Margin pixels per side (ignored for aspect-ratio presets, which compute margins). Default 128.")
        var pixels: Int = 128

        @Option(help: "Feather radius (px) across the keep/generate seam. Default 16.")
        var feather: Int = 16

        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 42
        @Option var steps: Int = 6
        @Option var cfgScale: Float = 1.0
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        @Flag var noArtifacts: Bool = false

        @Flag(help: "Abort (exit 1) if the output FAILs the image gate.")
        var strictGate: Bool = false

        func validate() throws {
            guard !prompt.isEmpty else { throw ValidationError("--prompt is required") }
            guard pixels >= 0 else { throw ValidationError("--pixels must be >= 0") }
            guard feather >= 0 else { throw ValidationError("--feather must be >= 0") }
        }

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()

            let inputURL = URL(fileURLWithPath: input)
            let (iw, ih) = try Flux2ImageLoad.imageSize(at: inputURL)

            print("flux2 expand — outpaint / image expansion")
            print("  input     : \(inputURL.lastPathComponent) (\(iw)×\(ih))")
            print("  expand    : \(expand)  (pixels=\(pixels), feather=\(feather))")
            print("  prompt    : \(prompt)")
            print("  steps     : \(steps), cfg: \(cfgScale), seed: \(seed)")

            // Load models (same block as scene/style).
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

            // Load input at native resolution (canvas derives from this).
            let inputPixels = try Flux2ImageLoad.loadArray(from: inputURL, targetSize: (width: iw, height: ih))

            print("  generating...")
            let (image, elapsed) = pipeline.outpaint(
                prompt: prompt, inputPixels: inputPixels,
                inputWidth: iw, inputHeight: ih,
                expand: expand, pixels: pixels, feather: feather,
                seed: seed, steps: steps, guidance: cfgScale)

            try ImageGate.check(image, label: "expand", strict: strictGate)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            try Flux2T2IPipeline.saveImage(image, to: URL(fileURLWithPath: paths.png))
            print("")
            print("✅ expanded \(URL(fileURLWithPath: paths.png).lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(paths.png)")
            if !noArtifacts {
                let runConfig = RunConfig(
                    transformer: transformer, prompt: prompt,
                    width: image.dim(3), height: image.dim(2),
                    steps: steps, seed: seed, cfgScale: cfgScale,
                    loraPaths: nil, loraScale: 1.0,
                    textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                    quantBits: 8, quantGroupSize: 64, command: "expand", pipeline: "flux2")
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
