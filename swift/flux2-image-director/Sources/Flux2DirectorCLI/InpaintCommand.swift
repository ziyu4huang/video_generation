//
//  InpaintCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 inpaint` — masked redraw / object removal, from an arbitrary EXTERNAL
//  mask image (white = regenerate, black = keep bit-for-bit). Port of the Python
//  app/commands/image-inpaint.py's production path (crop-for-detail mode is out
//  of scope for this port — see the code comment below).
//
//  Reuses Flux2EditPipeline.inpaint (already shipped for SwapCommand's
//  `--inpaint` seamless mode, which derives its mask from SAM3 detection). This
//  command is the same pipeline fed a user-supplied mask PNG instead — no new
//  denoise-loop or composite logic needed, only CLI plumbing + mask loading via
//  the existing Flux2ImageLoad.loadMaskAsChannel.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct Inpaint: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "inpaint",
            abstract: "Masked redraw / object removal — regenerate an arbitrary masked region (Flux2 latent-mask re-injection)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Source image to inpaint.")
        var input: String

        @Option(help: "Mask image path. White (255) = regenerate, black (0) = keep bit-for-bit. Grayscale or RGB (channel mean).")
        var mask: String

        @Option(help: "Prompt describing the content that should fill the masked region.")
        var prompt: String

        @Option(help: "Optional reference image for identity/content guidance of the redrawn region.")
        var reference: String?

        @Option(help: "Feather radius (px) across the keep/regenerate seam. Default 16.")
        var feather: Int = 16

        @Option(help: "Scale the input's longest side to this before inpainting (default 1024). Larger = more detail, slower.")
        var longest: Int = 1024

        @Option(name: .customLong("denoise-strength"),
                help: "SDEdit-style partial denoise strength on the masked region (default 1.0 = full regen; lower refines from the existing content).")
        var denoiseStrength: Float = 1.0

        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 42
        @Option var steps: Int = 8
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
            guard longest > 0 else { throw ValidationError("--longest must be > 0") }
            guard feather >= 0 else { throw ValidationError("--feather must be >= 0") }
            guard denoiseStrength > 0 && denoiseStrength <= 1.0 else {
                throw ValidationError("--denoise-strength must be in (0, 1.0]")
            }
        }

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()

            let inputURL = URL(fileURLWithPath: input)
            let maskURL = URL(fileURLWithPath: mask)
            let (iw, ih) = try Flux2ImageLoad.imageSize(at: inputURL)

            // Scale longest side to --longest, preserving aspect, then round to a
            // multiple of 16 (VAE patch grid) — mirrors image-inpaint.py's _round16.
            let scale = min(1.0, Double(longest) / Double(max(iw, ih)))
            let sw = max(16, Int((Double(iw) * scale).rounded()))
            let sh = max(16, Int((Double(ih) * scale).rounded()))
            let width = roundUp16(sw)
            let height = roundUp16(sh)

            print("flux2 inpaint — masked redraw")
            print("  input     : \(inputURL.lastPathComponent) (\(iw)×\(ih)) → \(width)×\(height)")
            print("  mask      : \(maskURL.lastPathComponent)  (feather=\(feather))")
            print("  prompt    : \(prompt)")
            print("  steps     : \(steps), cfg: \(cfgScale), seed: \(seed), denoise: \(denoiseStrength)")

            // Load models (same block as expand/scene/style).
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

            let srcArr = try Flux2ImageLoad.loadArray(
                from: inputURL, targetSize: (width: width, height: height))
            let maskArr = try Flux2ImageLoad.loadMaskAsChannel(
                from: maskURL, width: width, height: height)

            print("  generating...")
            let (image, elapsed) = pipeline.inpaint(
                prompt: prompt, sourcePixels: srcArr, sourceMask: maskArr,
                referencePath: reference.map { URL(fileURLWithPath: $0) },
                seed: seed, steps: steps, guidance: cfgScale,
                width: width, height: height, feather: feather,
                denoiseStrength: denoiseStrength)

            try ImageGate.check(image, label: "inpaint", strict: strictGate)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            try Flux2T2IPipeline.saveImage(image, to: URL(fileURLWithPath: paths.png))
            print("")
            print("✅ inpainted \(URL(fileURLWithPath: paths.png).lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(paths.png)")
            if !noArtifacts {
                let runConfig = RunConfig(
                    transformer: transformer, prompt: prompt,
                    width: width, height: height,
                    steps: steps, seed: seed, cfgScale: cfgScale,
                    loraPaths: nil, loraScale: 1.0,
                    textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                    quantBits: 8, quantGroupSize: 64, command: "inpaint", pipeline: "flux2")
                try runConfig.write(to: paths.runJSON)
                print("   run.json: \(paths.runJSON)")
            }
        }

        private func roundUp16(_ v: Int) -> Int {
            ((v + 15) / 16) * 16
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
