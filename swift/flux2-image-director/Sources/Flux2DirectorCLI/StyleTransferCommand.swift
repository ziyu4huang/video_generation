//
//  StyleTransferCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 styletransfer` — restyle a content image to a target visual
//  language (preset/prompt-driven), port of image-styletransfer.py.
//
//  Reuses Flux2EditPipeline.generate's existing initImagePath/denoiseStrength
//  params (SDEdit-style partial denoise, already wired by InpaintCommand's
//  --denoise-strength and SceneCommand's --bg/--bg-strength) — no new
//  denoise-loop or pipeline code, just CLI plumbing + style-prompt
//  resolution. Called with imagePaths: [] (no identity references — the
//  content image IS the canvas, not a reference).
//
//  --playbook style-source support (OM playbook YAML → image_prompt_prefix/
//  consistency_anchors/aesthetic) is deliberately OUT of v1 — no playbook
//  YAML parser exists anywhere in Swift/TS yet (see
//  docs/superpowers/specs/2026-07-30-styletransfer-swift-native-port-design.md).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct StyleTransfer: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "styletransfer",
            abstract: "Restyle a content image to a target visual language (Flux2 Klein SDEdit img2img)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Content image path (structure preserved).")
        var input: String

        @Option(name: .customLong("style-preset"),
                help: "Named style preset: clean-professional | watercolor | oil-painting | anime | cinematic | 3d-render | line-art | low-poly.")
        var stylePreset: String?

        @Option(help: "Free-form style description (amplifies or overrides the preset).")
        var prompt: String = ""

        @Option(help: "Style strength = img2img denoise (0-1]. Lower preserves more content structure; higher applies the style harder.")
        var strength: Float = 0.55

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
        @Flag var noArtifacts: Bool = false

        @Flag(help: "Abort (exit 1) if the output FAILs the image gate.")
        var strictGate: Bool = false

        /// LoRA name(s) (directories under models/lora/), repeatable. Multiple
        /// are rank-stacked into one merged adapter (see Flux2LoRALoader.merge).
        @Option(help: "LoRA name under models/lora/ (repeatable: --lora A --lora B stacks them).")
        var lora: [String] = []
        @Option(help: "Per-LoRA scale (repeatable, one per --lora; trailing ones default to 1.0).")
        var loraScale: [Float] = []

        static let stylePresets: [String: String] = [
            "clean-professional": "clean professional flat illustration, corporate style, white background, blue and orange accents, soft even lighting, generous whitespace, no grain, vector aesthetic",
            "watercolor": "loose watercolor painting, soft pigment bleeds, wet-on-wet washes, delicate color transitions, textured paper, hand-painted, artistic",
            "oil-painting": "classical oil painting, rich visible brushstrokes, warm golden lighting, chiaroscuro, museum-quality portraiture, impasto texture",
            "anime": "anime key visual, cel-shaded, clean line art, vibrant flat colors, detailed eyes, studio anime production, high quality",
            "cinematic": "cinematic film still, dramatic volumetric lighting, shallow depth of field, teal-and-orange color grade, anamorphic, 35mm film grain, moody atmosphere",
            "3d-render": "3D render, soft global illumination, subsurface scattering, Pixar-style stylized characters, rounded forms, polished materials",
            "line-art": "clean line art, single-weight ink outlines, minimal shading, monochrome, technical illustration, crisp vector strokes",
            "low-poly": "low-poly 3D illustration, faceted geometric surfaces, flat-shaded triangles, stylized minimal palette, isometric, clean",
        ]

        func validate() throws {
            guard strength > 0 && strength <= 1.0 else {
                throw ValidationError("--strength must be in (0, 1.0]")
            }
            if let stylePreset, !stylePreset.isEmpty {
                guard Self.stylePresets[stylePreset.lowercased()] != nil else {
                    throw ValidationError(
                        "unknown --style-preset '\(stylePreset)'. Available: "
                        + Self.stylePresets.keys.sorted().joined(separator: ", "))
                }
            } else if prompt.isEmpty {
                throw ValidationError("a style source is required — pass --style-preset <preset> and/or --prompt <text>.")
            }
        }

        private func resolveStylePrompt() -> String {
            var parts: [String] = []
            if let stylePreset, let text = Self.stylePresets[stylePreset.lowercased()] {
                parts.append(text)
            }
            if !prompt.isEmpty { parts.append(prompt) }
            return parts.joined(separator: ", ")
        }

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()

            let stylePrompt = resolveStylePrompt()
            print("flux2 styletransfer — restyle to target visual language")
            print("  input     : \(input)")
            print("  style     : \(stylePrompt.prefix(100))\(stylePrompt.count > 100 ? "…" : "")")
            print("  strength  : \(strength), steps: \(steps), size: \(width)×\(height), seed: \(seed)")

            let (loraAdapters, loraNames, _) = try Flux2LoRALoaderCLI.loadMerged(
                names: lora, scales: loraScale, logPrefix: "  lora      : ")
            if !loraNames.isEmpty {
                print("               merged \(loraAdapters.adapters.count) adapters from \(loraNames.count) LoRA(s)")
            }

            print("  loading models...")
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
                prompt: stylePrompt, imagePaths: [], seed: seed,
                height: height, width: width, steps: steps, guidance: cfgScale,
                initImagePath: URL(fileURLWithPath: input), denoiseStrength: strength)

            try ImageGate.check(pixels, label: "styletransfer", strict: strictGate)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            let imagePath = URL(fileURLWithPath: paths.png)
            try Flux2T2IPipeline.saveImage(pixels, to: imagePath)
            print("")
            print("✅ restyled \(imagePath.lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(imagePath.path)")

            if !noArtifacts {
                try writeArtifacts(paths: paths, stylePrompt: stylePrompt, elapsed: elapsed,
                                    loraNames: loraNames)
            }
        }

        private func writeArtifacts(paths: OutputPaths, stylePrompt: String, elapsed: Double,
                                     loraNames: [String]) throws {
            let startTime = Manifest.nowISO()
            let runConfig = RunConfig(
                transformer: transformer, prompt: stylePrompt,
                width: width, height: height, steps: steps, seed: seed, cfgScale: cfgScale,
                loraPaths: loraNames.isEmpty ? nil : loraNames, loraScale: 1.0,
                textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                quantBits: 8, quantGroupSize: 64, command: "styletransfer", pipeline: "flux2"
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
            for f in files { all.merge(try loadArrays(url: f)) { _, new in new } }
            return all
        }
    }
}
