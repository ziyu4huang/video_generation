//
//  T2ICommand.swift
//  Flux2DirectorCLI
//
//  `flux2 t2i` — text-to-image generation.
//
//  STATUS (Phase 1 scaffold): the CLI wiring, param resolution, and the
//  run.py-compatible audit trail (RunConfig + Manifest via CommonImageDirector)
//  are LIVE. The native MMDiT denoise loop lands in Phase 2 — until then this
//  command resolves params, writes the audit sidecars, and reports the port
//  status so the wiring is verifiable end-to-end.
//

import CommonImageDirector
import Flux2Director
import ArgumentParser
import Foundation

extension Flux2CLI {
    struct T2I: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "t2i",
            abstract: "Generate an image from a text prompt (Flux2 Klein)."
        )

        @OptionGroup var globals: GlobalOptions
        @OptionGroup var outputOptions: OutputOptions

        @Option(help: "Text prompt.")
        var prompt: String = ""

        @Option(help: "Transformer variant under models/transformer/.")
        var transformer: String = Flux2ModelRegistry.defaultTransformer

        @Option(help: "Random seed.")
        var seed: UInt64 = 42

        @Option(help: "Output image width (px).")
        var width: Int = 832

        @Option(help: "Output image height (px).")
        var height: Int = 1216

        @Option(help: "Number of denoising steps.")
        var steps: Int = 20

        @Option(help: "Classifier-free guidance scale (Flux2 uses 3.0-4.0).")
        var cfgScale: Float = 3.5

        @Option(help: "Output PNG path. Empty = auto timestamped name in output dir.")
        var output: String = ""

        @Option(help: "Output directory (default: ../video_generation__output, or MLX_OUTPUT_DIR).")
        var outputDir: String?

        @Option(help: "Custom base name (default: output_YYYYMMDD_HHMMSS).")
        var name: String?

        @Option(help: "VAE weights directory (under models/vae/).")
        var vae: String = Flux2ModelRegistry.defaultVAE

        @Option(help: "Text encoder directory (under models/text_encoder/).")
        var encoder: String = Flux2ModelRegistry.defaultTextEncoder

        @Option(help: "Tokenizer directory (under models/tokenizer/).")
        var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer

        func run() throws {
            globals.apply()
            let resolvedPrompt = prompt.isEmpty ? "(empty prompt — placeholder)" : prompt
            print("flux2 t2i — Flux2 Klein 9B (pure Swift MLX)")
            print("  transformer : \(transformer)")
            print("  prompt      : \(resolvedPrompt)")
            print("  size        : \(width)×\(height), steps: \(steps), cfg: \(cfgScale), seed: \(seed)")
            print("  vae/enc/tok : \(vae) / \(encoder) / \(tokenizerDir)")
            print("")
            print("⚠️  Native MMDiT denoise loop is Phase 2 (in progress).")
            print("    This run resolves params + writes the audit trail to verify wiring; no image is generated yet.")

            // Write the run.py-compatible audit sidecars to prove the
            // CommonImageDirector wiring works for flux2 (this is the
            // scaffold's purpose — the real pipeline lands in Phase 2).
            if outputOptions.writeRunJSON || outputOptions.writeManifest {
                try writeArtifacts(prompt: resolvedPrompt)
            }
        }

        private func writeArtifacts(prompt: String) throws {
            let startTime = Manifest.nowISO()
            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name
            )
            let runConfig = RunConfig(
                transformer: transformer, prompt: prompt,
                width: width, height: height,
                steps: steps, seed: seed, cfgScale: cfgScale,
                loraPaths: nil, loraScale: 1.0,
                textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                quantBits: 8, quantGroupSize: 64,
                command: "t2i", pipeline: "flux2"
            )
            if outputOptions.writeRunJSON {
                try runConfig.write(to: paths.runJSON)
            }
            let manifest = Manifest.success(
                runFile: paths.runJSON, startTime: startTime, endTime: Manifest.nowISO(),
                timings: ["note": 0.0], models: [:],
                outputFiles: [],
                quality: nil,
                perf: nil
            )
            if outputOptions.writeManifest {
                try manifest.write(to: paths.manifestJSON)
            }
            if outputOptions.writeRunJSON { print("Run config: \(paths.runJSON)") }
            if outputOptions.writeManifest { print("Manifest:   \(paths.manifestJSON)") }
        }
    }
}
