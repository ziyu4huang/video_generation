//
//  I2ICommand.swift
//  ZImageDirectorCLI
//
//  `zimage i2i` — image-to-image (SDEdit-style refinement / restyle).
//  Encodes an input image → latent, mixes with noise at `denoise_strength`,
//  denoises from the corresponding mid-trajectory step. Mirrors run.py's
//  img2img path (pipeline.py:595-604).
//
//  denoise_strength guide:
//    0.15–0.30 → light refine (fix small details / skin, keep composition)
//    0.40–0.60 → restyle (keep layout & subjects, change style/lighting)
//    0.70–0.90 → heavy redraw (loose composition, strong restyle)
//    1.00      → full regeneration (ignore input image)
//

import ArgumentParser
import Foundation
import MLX
import ZImageDirector

extension ZImageCLI {
    struct I2I: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "i2i",
            abstract: "Image-to-image: refine or restyle an input image via SDEdit (denoise-from-midpoint)."
        )

        @OptionGroup var globals: GlobalOptions
        @OptionGroup var outputOptions: OutputOptions

        @Option(help: "Input image path (PNG/JPEG) — the image to refine/restyle.")
        var inputImage: String

        @Option(help: "Edit/restyle prompt describing the desired output.")
        var prompt: String

        @Option(help: "Denoise strength 0.0–1.0 (how much to change the input; see command help).")
        var denoiseStrength: Float = 0.5

        @Option(help: "Transformer variant under models/transformer/.")
        var transformer: String = "moody-pro-mix"

        @Option(help: "Random seed.")
        var seed: UInt64 = 99

        @Option(help: "Output width (px; auto-aligned to multiple of 16; defaults to input width).")
        var width: Int?

        @Option(help: "Output height (px; auto-aligned to multiple of 16; defaults to input height).")
        var height: Int?

        @Option(help: "Number of denoising steps. Omit for the transformer's recommended value (manifest, else 9).")
        var steps: Int?

        @Option(help: "Classifier-free guidance scale. Omit for the transformer's recommended value.")
        var cfgScale: Float?

        @Option(help: "Output PNG path. Empty = auto-generate run.py-style output_YYYYMMDD_HHMMSS.")
        var output: String = ""

        @Option(help: "Output directory (default: ../video_generation__output, or MLX_OUTPUT_DIR env var).")
        var outputDir: String?

        @Option(help: "Custom base name (default: output_YYYYMMDD_HHMMSS).")
        var name: String?

        @Option(help: "Text encoder directory (under models/text_encoder/).")
        var encoder: String = "qwen3-4b"

        @Option(help: "Tokenizer directory (under models/tokenizer/).")
        var tokenizerDir: String = "qwen3"

        @Option(help: "VAE weights directory (under models/vae/).")
        var vae: String = "ultraflux-zimage-ae"

        @Option(help: "LoRA name (under models/lora/) or path to .safetensors. May be repeated.")
        var lora: [String] = []

        @Option(help: "LoRA strength (0.0-2.0). Repeatable; a single value broadcasts to all.")
        var loraScale: [Float] = []

        @Option(help: "Inpaint mask PNG (white=keep original, black=regenerate). When set, --denoise-strength is forced to 1.0 (full repaint of free region).")
        var mask: String?

        func run() throws {
            globals.apply()

            // Resolve dims — default to the input image's own size.
            let inURL = URL(fileURLWithPath: inputImage)
            let probePixels = try ImageLoad.loadArray(from: inURL)
            let inH = probePixels.shape[2]
            let inW = probePixels.shape[3]
            let resolvedW = width ?? inW
            let resolvedH = height ?? inH
            let validated = Resolution.validate(width: resolvedW, height: resolvedH)

            // Resolve steps/cfg from manifest defaults when omitted.
            let defaults = TransformerDefaultsRegistry.resolve(forTransformer: transformer)
            let resolvedSteps = steps ?? defaults.steps ?? 9
            let resolvedCfg = cfgScale ?? defaults.cfgScale ?? 1.0

            let strength = max(0.0, min(1.0, denoiseStrength))

            print("zimage i2i — image-to-image (SDEdit)")
            print("  transformer : \(transformer)")
            print("  input image : \(inputImage) (\(inW)×\(inH))")
            print("  prompt      : \(prompt)")
            print("  size        : \(validated.width)×\(validated.height)")
            print("  denoise     : \(String(format: "%.2f", strength)) (cfg=\(resolvedCfg), steps=\(resolvedSteps), seed=\(seed))")
            print("")

            // --- Load model context ---
            let loaded = try WeightStore.load(variant: transformer)
            print("transformer weights loaded: \(loaded.keyAudit.totalKeys) keys " +
                  "(\(loaded.config.quantBits)-bit, group_size=\(loaded.config.quantGroupSize))")

            let vaeURL = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/vae/\(vae)")
            let vaeWeights = try loadArrays(url: vaeURL.appendingPathComponent("model.safetensors"))
            print("vae weights loaded: \(vaeWeights.count) keys (encoder + decoder)")

            // Encode prompt → cap_feats (+ uncond for CFG).
            let (capFeats, uncondFeats, cfgActive) = try encodePrompt(
                prompt: prompt, cfgScale: resolvedCfg
            )

            // Apply LoRAs into the transformer weights.
            var transformerArrays = loaded.arrays
            let loraScales = loraScale.isEmpty
                ? [Float](repeating: 1.0, count: lora.count)
                : (loraScale.count == 1 ? [Float](repeating: loraScale[0], count: lora.count) : loraScale)
            for (index, loraName) in lora.enumerated() {
                let scale = index < loraScales.count ? loraScales[index] : (loraScales.last ?? 1.0)
                try applyLoRA(name: loraName, scale: scale, config: loaded.config, arrays: &transformerArrays)
            }

            let pipeline = T2IPipeline(
                transformerWeights: transformerArrays, vaeWeights: vaeWeights,
                config: loaded.config,
                groupSize: loaded.config.quantGroupSize, bits: loaded.config.quantBits
            )

            // --- Encode input image → clean latent ---
            print("encoding input image → latent...")
            let pixels = try ImageLoad.loadArray(
                from: inURL, targetSize: (validated.width, validated.height))
            let normalized = ImageLoad.normalizeForVAE(pixels)
            let cleanLatent = pipeline.encodeImage(normalized)
            print("clean latent: \(cleanLatent.shape)")

            // --- Load inpaint mask (if any) and downscale to latent space ---
            let maskArray: MLXArray?
            let effectiveStrength: Float
            if let maskPath = mask {
                // Mask spatial dims = latent dims (H/8 × W/8). The latent is
                // (1, 16, H/8, W/8); loadMask returns (1,1,H/8,W/8) which broadcasts.
                let maskURL = URL(fileURLWithPath: maskPath)
                maskArray = try ImageLoad.loadMask(
                    from: maskURL,
                    latentWidth: validated.width / 8,
                    latentHeight: validated.height / 8
                ).asType(.bfloat16)
                let meanVal = maskArray!.mean().item(Float.self)
                print("inpaint mask: \(maskArray!.shape) (mean=\(String(format: "%.3f", meanVal)), locked fraction)")
                // Force full denoise when inpainting so the free region regenerates.
                effectiveStrength = 1.0
                print("  → forcing denoise-strength=1.0 (inpaint mode)")
            } else {
                maskArray = nil
                effectiveStrength = strength
            }

            // --- Denoise (SDEdit or inpaint Repaint) ---
            let startTime = Manifest.nowISO()
            let img = pipeline.generate(
                capFeats: capFeats,
                uncondFeats: cfgActive ? uncondFeats : nil,
                seed: seed, width: validated.width, height: validated.height,
                steps: resolvedSteps, cfgScale: resolvedCfg,
                cleanLatent: cleanLatent, denoiseStrength: effectiveStrength,
                mask: maskArray
            )

            // --- Save ---
            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name
            )
            let outURL = URL(fileURLWithPath: paths.png)
            try ImageSave.savePNG(img, to: outURL)
            print("\n✅ saved \(outURL.path)  (\(img.shape))")

            // --- Manifest (run.py-compatible .run.json + .manifest.json) ---
            let endTime = Manifest.nowISO()
            let runConfig = RunConfig(
                transformer: transformer, prompt: prompt,
                width: validated.width, height: validated.height,
                steps: resolvedSteps, seed: seed, cfgScale: resolvedCfg,
                loraPaths: lora.isEmpty ? nil : lora, loraScale: loraScales.first ?? 1.0,
                loraScales: loraScales.count > 1 ? loraScales : nil,
                textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                quantBits: loaded.config.quantBits, quantGroupSize: loaded.config.quantGroupSize,
                command: "i2i"
            )
            if outputOptions.writeRunJSON {
                try runConfig.write(to: paths.runJSON)
            }
            let attrs = try FileManager.default.attributesOfItem(atPath: paths.png)
            let sizeBytes = (attrs[.size] as? Int64) ?? 0
            let outInfo = ManifestOutput(
                path: paths.png, seed: Int(seed),
                sizeBytes: sizeBytes, width: validated.width, height: validated.height
            )
            let manifest = Manifest.success(
                runFile: paths.runJSON, startTime: startTime, endTime: endTime,
                timings: [:], models: [:], outputFiles: [outInfo], quality: nil,
                perf: pipeline.lastPerf
            )
            if outputOptions.writeManifest {
                try manifest.write(to: paths.manifestJSON)
            }
            if outputOptions.writeRunJSON { print("Run config: \(paths.runJSON)") }
            if outputOptions.writeManifest { print("Manifest:   \(paths.manifestJSON)") }
        }

        // MARK: - Helpers (mirrors T2ICommand)

        private func encodePrompt(prompt: String, cfgScale: Float) throws -> (MLXArray, MLXArray?, Bool) {
            print("loading text encoder...")
            let encoderURL = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/text_encoder/\(encoder)")
            let encWeights = try TextEncoderWeights.load(dir: encoderURL)
            let textEncoder = Qwen3TextEncoder.build(weights: encWeights)
            print("loading tokenizer...")
            let tokURL = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/tokenizer/\(tokenizerDir)/tokenizer.json")
            var tokenizer = BPETokenizer(jsonURL: tokURL)!
            print("encoding prompt...")
            let capFeats = encode(textEncoder, &tokenizer, prompt)
            let cfgActive = cfgScale != 1.0
            var uncondFeats: MLXArray?
            if cfgActive {
                print("encoding empty prompt (CFG)...")
                uncondFeats = encode(textEncoder, &tokenizer, "")
            }
            print("cap_feats: \(capFeats.shape), cfg=\(cfgActive ? "on" : "off")")
            return (capFeats, uncondFeats, cfgActive)
        }

        private func encode(_ encoder: Qwen3TextEncoder, _ tokenizer: inout BPETokenizer, _ text: String) -> MLXArray {
            let ids = tokenizer.encodePrompt(text, maxLength: 512).map { Double($0) }
            let idArray = MLXArray(converting: ids, [1, 512])
            return encoder(idArray.asType(.int32)).asType(.bfloat16)
        }

        private func applyLoRA(
            name: String, scale: Float, config: TransformerConfig,
            arrays: inout [String: MLXArray]
        ) throws {
            let loraPath: String
            if name.hasSuffix(".safetensors") || FileManager.default.fileExists(atPath: name) {
                loraPath = name
            } else {
                let loraDir = ModelPaths.lora(name)
                let contents = (try? FileManager.default.contentsOfDirectory(atPath: loraDir.path)) ?? []
                guard let f = contents.first(where: { $0.hasSuffix(".safetensors") && !$0.hasPrefix(".") }) else {
                    throw ValidationError("No .safetensors found in LoRA dir: \(loraDir.path)")
                }
                loraPath = loraDir.appendingPathComponent(f).path
            }
            print("applying LoRA: \(name) (scale=\(scale))...")
            let info = try LoRALoader.apply(to: &arrays, config: config, loraPath: loraPath, userScale: scale)
            print("  LoRA applied: \(info.appliedLayers)/\(info.totalLayers) layers, rank=\(info.rank)")
        }
    }
}
