//
//  InpaintControlNetCommand.swift
//  ZImageDirectorCLI
//
//  `zimage inpaint-cn` — high-quality inpainting via Union ControlNet 2.1
//  (Turbo-only). Higher quality than the latent Repaint path in `i2i --mask`
//  because the ControlNet injects learned residuals into the transformer.
//
//  The 33-channel control input is:
//    [control_latent(16), mask(1), inpaint_latent(16)]
//  where control_latent = VAE(input_image) and inpaint_latent = VAE(input_image)
//  (same image — anchors appearance in the preserved region).
//

import ArgumentParser
import Foundation
import MLX
import ZImageDirector

extension ZImageCLI {
    struct InpaintCN: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "inpaint-cn",
            abstract: "Inpainting via Union ControlNet 2.1 (Turbo-only, higher quality than i2i --mask)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Input image path (PNG/JPEG) — the image to inpaint.")
        var inputImage: String

        @Option(help: "Inpaint mask PNG (white=regenerate, black=preserve).")
        var mask: String

        @Option(help: "Prompt describing the desired inpainted content.")
        var prompt: String

        @Option(help: "ControlNet variant (under models/controlnet/).")
        var controlnet: String = "zimage-turbo-fun-union-2.1-mlx"

        @Option(help: "ControlNet strength (0.0–2.0; 1.0 = nominal).")
        var controlnetStrength: Float = 1.0

        @Option(help: "Transformer variant (MUST be Turbo-family for this ControlNet).")
        var transformer: String = "moody-pro-mix"

        @Option(help: "Random seed.")
        var seed: UInt64 = 99

        @Option(help: "Output width (px; auto-aligned to 16; defaults to input width).")
        var width: Int?

        @Option(help: "Output height (px; auto-aligned to 16; defaults to input height).")
        var height: Int?

        @Option(help: "Denoise steps. Omit for transformer default.")
        var steps: Int?

        @Option(help: "CFG scale. Omit for transformer default.")
        var cfgScale: Float?

        @Option(help: "Output PNG path. Empty = auto output_YYYYMMDD_HHMMSS.")
        var output: String = ""

        @Option(help: "Output directory (default: ../video_generation__output).")
        var outputDir: String?

        @Option(help: "Custom base name.")
        var name: String?

        @Option(help: "Text encoder directory.")
        var encoder: String = "qwen3-4b"

        @Option(help: "Tokenizer directory.")
        var tokenizerDir: String = "qwen3"

        @Option(help: "VAE weights directory.")
        var vae: String = "ultraflux-zimage-ae"

        func run() throws {
            globals.apply()

            let inURL = URL(fileURLWithPath: inputImage)
            let maskURL = URL(fileURLWithPath: mask)
            let probePixels = try ImageLoad.loadArray(from: inURL)
            let inH = probePixels.shape[2]
            let inW = probePixels.shape[3]
            let resolvedW = width ?? inW
            let resolvedH = height ?? inH
            let validated = Resolution.validate(width: resolvedW, height: resolvedH)

            let defaults = TransformerDefaultsRegistry.resolve(forTransformer: transformer)
            let resolvedSteps = steps ?? defaults.steps ?? 9
            let resolvedCfg = cfgScale ?? defaults.cfgScale ?? 1.0

            print("zimage inpaint-cn — ControlNet 2.1 inpainting")
            print("  transformer : \(transformer) (Turbo)")
            print("  controlnet  : \(controlnet) (strength=\(controlnetStrength))")
            print("  input image : \(inputImage) (\(inW)×\(inH))")
            print("  mask        : \(mask)")
            print("  prompt      : \(prompt)")
            print("  size        : \(validated.width)×\(validated.height)")
            print("  cfg/steps   : \(resolvedCfg) / \(resolvedSteps) (seed=\(seed))")
            print("")

            // --- Load transformer + VAE ---
            let loaded = try WeightStore.load(variant: transformer)
            print("transformer: \(loaded.keyAudit.totalKeys) keys")
            let vaeURL = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/vae/\(vae)")
            let vaeWeights = try loadArrays(url: vaeURL.appendingPathComponent("model.safetensors"))

            // --- Load ControlNet ---
            let cnetDir = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/controlnet/\(controlnet)")
            let cnetFile = cnetDir.appendingPathComponent("model.safetensors")
            guard FileManager.default.fileExists(atPath: cnetFile.path) else {
                throw ValidationError("controlnet not found: \(cnetFile.path)")
            }
            let cnetArrays = try loadArrays(url: cnetFile)
            let cnet = ZImageControlNet(weights: cnetArrays, groupSize: 32, bits: 4)
            print("controlnet: \(cnetArrays.count) keys, \(cnet.nControlLayers) control layers")

            // --- Encode prompt ---
            let (capFeats, uncondFeats, cfgActive) = try encodePrompt(
                prompt: prompt, cfgScale: resolvedCfg)

            let pipeline = T2IPipeline(
                transformerWeights: loaded.arrays, vaeWeights: vaeWeights,
                config: loaded.config,
                groupSize: loaded.config.quantGroupSize, bits: loaded.config.quantBits
            )

            // --- Load input image + mask ---
            print("encoding input image → latent...")
            let pixels = try ImageLoad.loadArray(
                from: inURL, targetSize: (validated.width, validated.height))
            let normalized = ImageLoad.normalizeForVAE(pixels)
            let inputLatent = pipeline.encodeImage(normalized)
            print("input latent: \(inputLatent.shape)")

            let latentH = validated.height / 8
            let latentW = validated.width / 8
            let maskLatent = try ImageLoad.loadMask(
                from: maskURL, latentWidth: latentW, latentHeight: latentH
            ).asType(.bfloat16)
            let maskMean: Float = maskLatent.mean().item(Float.self)
            print("mask latent: \(maskLatent.shape) (mean=\(String(format: "%.3f", maskMean)))")

            // --- Build 33-channel control input ---
            // control_latent = inpaint_latent = VAE(input_image). The ControlNet
            // uses the mask channel to know WHERE to regenerate.
            let ctrl33 = ControlNetInput.build33ch(
                ctrlLatent: inputLatent, inpaintLatent: inputLatent, mask: maskLatent)
            print("control input: \(ctrl33.shape) [ctrl(16)+mask(1)+inpaint(16)]")

            // --- Generate with ControlNet + latent Repaint mask re-injection ---
            // We pass BOTH controlnet AND mask: ControlNet guides the transformer,
            // while the Repaint mask locks the preserved region each step.
            let startTime = Manifest.nowISO()
            let img = pipeline.generate(
                capFeats: capFeats,
                uncondFeats: cfgActive ? uncondFeats : nil,
                seed: seed, width: validated.width, height: validated.height,
                steps: resolvedSteps, cfgScale: resolvedCfg,
                mask: maskLatent,   // lock preserved region via Repaint
                controlnet: cnet, controlImage33ch: ctrl33,
                controlnetStrength: controlnetStrength
            )

            // --- Save ---
            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            let outURL = URL(fileURLWithPath: paths.png)
            try ImageSave.savePNG(img, to: outURL)
            print("\n✅ saved \(outURL.path)  (\(img.shape))")

            let endTime = Manifest.nowISO()
            let runConfig = RunConfig(
                transformer: transformer, prompt: prompt,
                width: validated.width, height: validated.height,
                steps: resolvedSteps, seed: seed, cfgScale: resolvedCfg,
                loraPaths: nil, loraScale: 1.0,
                textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                quantBits: loaded.config.quantBits,
                quantGroupSize: loaded.config.quantGroupSize,
                command: "inpaint-cn")
            try runConfig.write(to: paths.runJSON)
            let attrs = try FileManager.default.attributesOfItem(atPath: paths.png)
            let sizeBytes = (attrs[.size] as? Int64) ?? 0
            let outInfo = ManifestOutput(
                path: paths.png, seed: Int(seed),
                sizeBytes: sizeBytes, width: validated.width, height: validated.height)
            let manifest = Manifest.success(
                runFile: paths.runJSON, startTime: startTime, endTime: endTime,
                timings: [:], models: [:], outputFiles: [outInfo], quality: nil)
            try manifest.write(to: paths.manifestJSON)
            print("Run config: \(paths.runJSON)")
            print("Manifest:   \(paths.manifestJSON)")
        }

        // MARK: - Helpers

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
    }
}
