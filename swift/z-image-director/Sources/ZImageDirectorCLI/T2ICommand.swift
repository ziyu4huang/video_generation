//
//  T2ICommand.swift
//  ZImageDirectorCLI
//
//  `zimage t2i` — text-to-image generation (mirrors `run.py image t2i`).
//

import CommonImageDirector
import ArgumentParser
import Foundation
import ImageGenUtils
import MLX
import ZImageDirector

/// Resolved generation parameters (from flags + presets).
private struct GenParams {
    let prompt: String
    let width: Int
    let height: Int
    let steps: Int
    let seed: UInt64
    let cfgScale: Float
    let loraList: [String]
    let loraScales: [Float]
}

/// Loaded model context passed from load to generate phase.
private struct PipelineContext {
    let pipeline: T2IPipeline
    let capFeats: MLXArray
    let uncondFeats: MLXArray?
    let cfgActive: Bool
    let fixedNoise: MLXArray?
    let quantBits: Int
    let quantGroupSize: Int
}

extension ZImageCLI {
    struct T2I: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "t2i",
            abstract: "Generate an image from a text prompt."
        )

        @OptionGroup var globals: GlobalOptions
        @OptionGroup var outputOptions: OutputOptions

        @Option(help: "Text prompt (required unless --self-test is used).")
        var prompt: String = ""

        @Option(help: "Transformer variant under models/transformer/.")
        var transformer: String = "moody-pro-mix"

        @Option(help: "Random seed.")
        var seed: UInt64 = 99

        @Option(help: "Output image width (px; auto-aligned to multiple of 16).")
        var width: Int = 640

        @Option(help: "Output image height (px; auto-aligned to multiple of 16).")
        var height: Int = 960

        @Option(help: "Resolution tier or preset: model|benchmark|large|portrait|landscape|1080p|9:16|16:9|1024|WxH. 'model' = per-checkpoint training-optimal (default).")
        var resolution: String?

        @Option(help: "Number of denoising steps. Omit for the transformer's recommended value (manifest recommended_steps, else 9).")
        var steps: Int?

        @Option(help: "Classifier-free guidance scale. Omit for the transformer's recommended value (manifest recommended_cfg, else 4.0).")
        var cfgScale: Float?

        @Option(help: "Output PNG path. Empty = auto-generate run.py-style output_YYYYMMDD_HHMMSS in the output dir.")
        var output: String = ""

        @Option(help: "Output directory (default: ../video_generation__output, or MLX_OUTPUT_DIR env var).")
        var outputDir: String?

        @Option(help: "Custom base name (default: output_YYYYMMDD_HHMMSS).")
        var name: String?

        @Option(help: "Optional pre-computed embedding safetensors. Omit to use text encoder directly.")
        var embedding: String?

        @Option(help: "Text encoder directory (under models/text_encoder/).")
        var encoder: String = "qwen3-4b"

        @Option(help: "Tokenizer directory (under models/tokenizer/).")
        var tokenizerDir: String = "qwen3"

        @Option(help: "VAE weights directory (under models/vae/).")
        var vae: String = "ultraflux-zimage-ae"

        @Option(help: "Optional fixed-noise safetensors (key 'noise'). Omit to use --seed.")
        var noiseFile: String?

        @Option(help: "LoRA name (under models/lora/) or path to .safetensors. May be repeated.")
        var lora: [String] = []

        @Option(help: "LoRA strength (0.0-2.0). Repeatable — one per --lora, in order; a single value broadcasts to all LoRAs.")
        var loraScale: [Float] = []

        @Option(help: "Built-in test preset: portrait|landscape|complex-girl|lora:jibmix|lora:asian-girl.")
        var selfTest: String?

        @Flag(help: "After generating, score via Qwen3-VL and retry with more steps if below threshold.")
        var selfCritique: Bool = false

        @Flag(help: "Compute 7 programmatic quality metrics (sharpness/contrast/...) and write to manifest.")
        var metrics: Bool = false

        @Flag(help: "Generate a VLM review (prompt adherence, issues, summary) and write to manifest.")
        var review: Bool = false

        @Option(help: "VLM score threshold for --self-critique (overall AND artifacts must both >= this).")
        var critiqueThreshold: Int = 7

        @Option(help: "Max retry attempts for --self-critique (each adds +4 steps; default 2).")
        var critiqueRetries: Int = 2

        func run() throws {
            globals.apply()
            let params = try resolveParams()
            let ctx = try loadPipeline(params: params)
            try generateWithCritique(params: params, ctx: ctx)
        }

        // MARK: - Param resolution

        /// Resolve all generation params from flags + presets.
        ///
        /// Sentinel pattern (mirrors python RunConfig.from_args): `steps` / `cfgScale`
        /// default to nil so we can tell "user passed a flag" from "user accepted the
        /// default". Transformer manifest defaults fill nils BEFORE the global
        /// fallbacks (9 steps / 4.0 cfg) — an explicit user flag always wins.
        private func resolveParams() throws -> GenParams {
            // Per-checkpoint recommended params (manifest-first, built-in fallback).
            // Applied only to fields the user left nil.
            let defaults = TransformerDefaultsRegistry.resolve(forTransformer: transformer)
            let resolvedSteps = steps ?? defaults.steps ?? 9
            let resolvedCfg = cfgScale ?? defaults.cfgScale ?? 1.0
            // Skip the "using manifest default" note under --self-test: the preset
            // carries its own fixed steps/cfg and overrides these, so the note
            // would be misleading. It's accurate for real (no-self-test) runs.
            if selfTest == nil {
                if defaults.steps != nil && steps == nil {
                    print("  steps      : using manifest default \(resolvedSteps)")
                }
                if defaults.cfgScale != nil && cfgScale == nil {
                    print("  cfg-scale  : using manifest default \(resolvedCfg)")
                }
            }

            // Resolve per-LoRA scales: broadcast a single value across all
            // LoRAs (python also supports a list — `--lora-scale` is repeatable
            // here, paired by index; a lone value broadcasts).
            let loraCount = lora.count
            let resolvedLoraScales: [Float] = {
                if loraScale.isEmpty { return [Float](repeating: 1.0, count: loraCount) }
                if loraScale.count == 1 { return [Float](repeating: loraScale[0], count: loraCount) }
                return loraScale
            }()

            var params = GenParams(
                prompt: prompt, width: width, height: height,
                steps: resolvedSteps, seed: seed, cfgScale: resolvedCfg,
                loraList: lora, loraScales: resolvedLoraScales
            )
            if let selfTest {
                guard let preset = SelfTestPresets.find(selfTest) else {
                    let names = SelfTestPresets.all.map { $0.name }.joined(separator: ", ")
                    throw ValidationError("Unknown self-test: \(selfTest) (available: \(names))")
                }
                let presetLoraList = preset.lora.map { [$0] } ?? lora
                let presetScales = preset.lora.map { _ in [preset.loraScale] } ?? resolvedLoraScales
                params = GenParams(
                    prompt: preset.prompt, width: preset.width, height: preset.height,
                    steps: preset.steps, seed: preset.seed, cfgScale: preset.cfgScale,
                    loraList: presetLoraList, loraScales: presetScales
                )
                print("  self-test  : \(selfTest) — \(preset.description)")
            }
            if params.prompt.isEmpty && selfTest == nil {
                throw ValidationError("--prompt is required (or use --self-test)")
            }
            // Resolution tier/preset takes precedence over --width/--height so
            // benchmark/self-learning can run at model-optimal or larger. When no
            // --resolution is given, the explicit --width/--height (default
            // 640×960 = zimage 'model' tier) stand.
            if let resolution {
                guard let preset = CommonImageDirector.Resolution.resolvePreset(
                    resolution, pipeline: .zimage
                ) else {
                    throw ValidationError("Unknown resolution preset: \(resolution)")
                }
                params = GenParams(
                    prompt: params.prompt, width: preset.w, height: preset.h,
                    steps: params.steps, seed: params.seed, cfgScale: params.cfgScale,
                    loraList: params.loraList, loraScales: params.loraScales
                )
                print("  resolution : \(resolution) → \(preset.w)×\(preset.h)")
            }
            let validated = CommonImageDirector.Resolution.validate(width: params.width, height: params.height)
            return GenParams(
                prompt: params.prompt, width: validated.width, height: validated.height,
                steps: params.steps, seed: params.seed, cfgScale: params.cfgScale,
                loraList: params.loraList, loraScales: params.loraScales
            )
        }

        // MARK: - Model loading

        /// Load transformer + VAE weights, encode prompt, apply LoRA, build pipeline.
        private func loadPipeline(params: GenParams) throws -> PipelineContext {
            printHeader(params: params)
            let loaded = try WeightStore.load(variant: transformer)
            print("transformer weights loaded: \(loaded.keyAudit.totalKeys) keys " +
                  "(\(loaded.config.quantBits)-bit, group_size=\(loaded.config.quantGroupSize))")

            let vaeURL = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/vae/\(vae)")
            let vaeWeights = try loadArrays(url: vaeURL.appendingPathComponent("model.safetensors"))
            print("vae weights loaded: \(vaeWeights.count) keys")

            let (capFeats, uncondFeats, cfgActive) = try encodePrompt(params: params)

            var transformerArrays = loaded.arrays
            for (index, loraName) in params.loraList.enumerated() {
                let scale = index < params.loraScales.count
                    ? params.loraScales[index]
                    : (params.loraScales.last ?? 1.0)
                try applySingleLoRA(
                    name: loraName, scale: scale,
                    config: loaded.config, arrays: &transformerArrays
                )
            }

            let pipeline = T2IPipeline(
                transformerWeights: transformerArrays, vaeWeights: vaeWeights,
                config: loaded.config,
                groupSize: loaded.config.quantGroupSize, bits: loaded.config.quantBits
            )
            let fixedNoise: MLXArray? = try noiseFile.map { path in
                try loadArrays(url: URL(fileURLWithPath: path))["noise"]!
            }
            return PipelineContext(
                pipeline: pipeline, capFeats: capFeats, uncondFeats: uncondFeats,
                cfgActive: cfgActive, fixedNoise: fixedNoise,
                quantBits: loaded.config.quantBits,
                quantGroupSize: loaded.config.quantGroupSize
            )
        }

        private func printHeader(params: GenParams) {
            print("zimage t2i — end-to-end generation")
            print("  transformer : \(transformer)")
            print("  prompt      : \(params.prompt)")
            print("  size        : \(params.width)×\(params.height)")
            print("  steps       : \(params.steps), cfg: \(params.cfgScale), seed: \(params.seed)")
            if let embedding {
                print("  embedding   : \(embedding)")
            } else {
                print("  encoder     : \(encoder) (in-process text encoding)")
            }
            print("  output      : \(output)")
            print("")
        }

        /// Encode the prompt → cap_feats (and uncond for CFG), via embedding file
        /// or the in-process Qwen3 text encoder.
        private func encodePrompt(params: GenParams) throws -> (MLXArray, MLXArray?, Bool) {
            if let embedding {
                let emb = try loadArrays(url: URL(fileURLWithPath: embedding))
                let capFeats = emb["cap_feats"]!
                let uncondFeats = emb["uncond_feats"]
                let cfgActive = uncondFeats != nil && params.cfgScale != 1.0
                print("prompt embedding: \(capFeats.shape), cfg=\(cfgActive ? "on" : "off")")
                return (capFeats, uncondFeats, cfgActive)
            }
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
            let capFeats = encode(textEncoder, &tokenizer, params.prompt)
            let cfgActive = params.cfgScale != 1.0
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

        /// Resolve a LoRA name/path and bake its delta into the transformer weights.
        private func applySingleLoRA(
            name: String, scale: Float, config: TransformerConfig,
            arrays: inout [String: MLXArray]
        ) throws {
            let loraPath: String
            if name.hasSuffix(".safetensors") || FileManager.default.fileExists(atPath: name) {
                loraPath = name
            } else {
                // Resolve via ModelPaths.lora() so --models-root / $MLX_MODELS_DIR
                // is honored; prefer the registry's declared weight_file.
                let loraDir = ModelPaths.lora(name)
                let weightName = ModelRegistry.manifest(forType: "lora", name: name)?.weightFile
                if let weightName {
                    let direct = loraDir.appendingPathComponent(weightName)
                    if FileManager.default.fileExists(atPath: direct.path) {
                        loraPath = direct.path
                    } else {
                        loraPath = loraDir.appendingPathComponent(weightName).path
                    }
                } else {
                    let contents = (try? FileManager.default.contentsOfDirectory(atPath: loraDir.path)) ?? []
                    guard let safetensorsFile = contents.first(
                        where: { $0.hasSuffix(".safetensors") && !$0.hasPrefix(".") }
                    ) else {
                        throw ValidationError("No .safetensors found in LoRA dir: \(loraDir.path)")
                    }
                    loraPath = loraDir.appendingPathComponent(safetensorsFile).path
                }
            }
            print("applying LoRA: \(name) (scale=\(scale))...")
            let info = try LoRALoader.apply(
                to: &arrays, config: config, loraPath: loraPath, userScale: scale
            )
            print("  LoRA applied: \(info.appliedLayers)/\(info.totalLayers) layers, rank=\(info.rank)")
            if info.appliedLayers == 0 {
                throw ValidationError("LoRA applied 0 layers — key mismatch?")
            }
        }

        // MARK: - Generation + self-critique loop

        /// Generate the image, optionally retrying with more steps when the
        /// VLM scores it below threshold.
        private func generateWithCritique(params: GenParams, ctx: PipelineContext) throws {
            let startTime = Manifest.nowISO()
            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name
            )
            let outURL = URL(fileURLWithPath: paths.png)
            if output.isEmpty {
                print("  output dir : \((paths.png as NSString).deletingLastPathComponent)")
                print("  base name  : \(paths.baseName)")
            }
            var attemptSteps = params.steps
            var attemptSeed = params.seed
            let maxAttempts = selfCritique ? (1 + critiqueRetries) : 1
            var finalSeed = params.seed
            var finalImage: MLXArray? = nil

            for attempt in 1...maxAttempts {
                if selfCritique && attempt > 1 {
                    print("\n--- self-critique retry \(attempt - 1)/\(critiqueRetries): " +
                          "steps \(attemptSteps) (was \(attemptSteps - 4)), seed \(attemptSeed) ---")
                }
                let img = ctx.pipeline.generate(
                    capFeats: ctx.capFeats,
                    uncondFeats: ctx.cfgActive ? ctx.uncondFeats : nil,
                    seed: attemptSeed, width: params.width, height: params.height,
                    steps: attemptSteps, cfgScale: params.cfgScale,
                    fixedNoise: ctx.fixedNoise
                )
                try ImageSave.savePNG(img, to: outURL)
                finalSeed = attemptSeed
                finalImage = img
                print("\n✅ saved \(outURL.path)  (", img.shape, ")")

                guard selfCritique, attempt < maxAttempts else { break }

                let score = try? critiqueScore(imageURL: outURL)
                guard let score, !score.passes(threshold: critiqueThreshold) else { break }
                print("  attempt \(attempt): overall=\(score.overall) artifacts=\(score.artifacts) " +
                      "— FAIL ❌ (retrying)")
                if !score.issues.isEmpty {
                    print("  issues: \(score.issues.joined(separator: "; "))")
                }
                attemptSteps = min(attemptSteps + 4, 20)
                attemptSeed = attemptSeed &+ 1
            }

            // Write run.py-compatible .run.json + .manifest.json siblings
            // (default ON for debug; --no-manifest / --no-run-json opt out).
            if outputOptions.noRunJSON && outputOptions.noManifest {
                print("(--no-manifest --no-run-json: skipped audit files)")
                return
            }
            try writeRunArtifacts(paths: paths, params: params, finalSeed: finalSeed,
                                  startTime: startTime, ctx: ctx,
                                  finalImage: finalImage, outURL: outURL)
        }

        /// Write the .run.json (input params) and .manifest.json (output audit).
        private func writeRunArtifacts(
            paths: OutputPaths, params: GenParams, finalSeed: UInt64,
            startTime: String, ctx: PipelineContext,
            finalImage: MLXArray?, outURL: URL
        ) throws {
            let endTime = Manifest.nowISO()
            let runConfig = RunConfig(
                transformer: transformer, prompt: params.prompt,
                width: params.width, height: params.height,
                steps: params.steps, seed: finalSeed, cfgScale: params.cfgScale,
                loraPaths: params.loraList,
                loraScale: params.loraScales.first ?? 1.0,
                loraScales: params.loraScales.count > 1 ? params.loraScales : nil,
                textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                quantBits: ctx.quantBits, quantGroupSize: ctx.quantGroupSize
            )
            if outputOptions.writeRunJSON {
                try runConfig.write(to: paths.runJSON)
            }

            let attrs = try FileManager.default.attributesOfItem(atPath: paths.png)
            let sizeBytes = (attrs[.size] as? Int64) ?? 0
            let output = ManifestOutput(
                path: paths.png, seed: Int(finalSeed),
                sizeBytes: sizeBytes, width: params.width, height: params.height
            )
            let quality = computeQualityReport(
                finalImage: finalImage, outURL: outURL, params: params
            )
            let manifest = Manifest.success(
                runFile: paths.runJSON, startTime: startTime, endTime: endTime,
                timings: [:], models: [:], outputFiles: [output], quality: quality,
                perf: ctx.pipeline.lastPerf
            )
            if outputOptions.writeManifest {
                try manifest.write(to: paths.manifestJSON)
            }
            if outputOptions.writeRunJSON { print("Run config: \(paths.runJSON)") }
            if outputOptions.writeManifest { print("Manifest:   \(paths.manifestJSON)") }
        }

        /// Build the dual quality report (programmatic metrics + optional VLM review).
        private func computeQualityReport(
            finalImage: MLXArray?, outURL: URL, params: GenParams
        ) -> QualityReport? {
            var programmatic: [String: Double]? = nil
            if metrics, let image = finalImage {
                let measured = QualityMetrics.analyze(image)
                programmatic = measured.dictionary
                print("\n[metrics] sharpness=\(String(format: "%.1f", measured.sharpness)) " +
                      "edge=\(String(format: "%.2f", measured.edgeDensity)) " +
                      "contrast=\(String(format: "%.2f", measured.contrast)) " +
                      "noise=\(String(format: "%.3f", measured.noiseSigma)) " +
                      "snr=\(String(format: "%.1f", measured.snrDb))dB " +
                      "block=\(String(format: "%.3f", measured.blockiness)) " +
                      "sat=\(String(format: "%.3f", measured.saturationStd))")
            }

            var vlmOverall: Int? = nil
            var vlmArtifacts: Int? = nil
            var vlmIssues: [String]? = nil
            var vlmSummary: String? = nil
            if review {
                if let score = try? critiqueScore(imageURL: outURL) {
                    vlmOverall = score.overall
                    vlmArtifacts = score.artifacts
                    vlmIssues = score.issues.isEmpty ? nil : score.issues
                    vlmSummary = score.summary
                    print("[review] overall=\(score.overall) artifacts=\(score.artifacts)")
                } else {
                    print("[review] VLM unavailable (LM Studio down?) — skipping")
                }
            }

            let anyPresent = programmatic != nil
                || vlmOverall != nil || vlmArtifacts != nil
                || vlmIssues != nil || vlmSummary != nil
            guard anyPresent else { return nil }
            return QualityReport(
                programmatic: programmatic, vlmOverall: vlmOverall,
                vlmArtifacts: vlmArtifacts, vlmIssues: vlmIssues, vlmSummary: vlmSummary
            )
        }

        /// Score a saved image via Qwen3-VL; returns nil if the VLM is unavailable.
        private func critiqueScore(imageURL: URL) throws -> CaptionScore? {
            print("\n[self-critique] scoring via Qwen3-VL...")
            do {
                let raw = try CaptionClient.caption(
                    imageURL: imageURL, style: "score",
                    apiURL: CaptionClient.defaultAPIURL,
                    model: CaptionClient.defaultModel
                )
                return CaptionClient.parseScore(raw)
            } catch {
                print("  ⚠️ VLM unavailable (\(error)); skipping critique.")
                return nil
            }
        }
    }
}
