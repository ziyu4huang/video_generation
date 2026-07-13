//
//  FaceSwapCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 faceswap` — BFS (Best Face Swap) via Flux2 Klein 9B + BFS LoRA.
//  Port of python/mlx-movie-director/app/commands/image-faceswap.py's
//  `_run_faceswap_core` real-usage path (normal mode only — the --self-test
//  source-synthesis + VLM-scoring + HTML-review phases stay on Python; see
//  module notes in registry.ts's runpy_image entry).
//
//  Source: https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap
//
//  Technique: Flux2 Klein 9B is loaded with the BFS LoRA fused in AT INIT
//  TIME (Klein's distilled architecture requires this — LoRA cannot be
//  applied post-hoc at generate time), then two reference images (body +
//  face) are passed to Flux2KleinEdit with a fixed swap prompt. The model
//  combines the body/pose of Image 1 with the face from Image 2.
//
//  Reuses two already-native mechanisms that, before this command, were only
//  ever exercised separately: Flux2EditPipeline's multi-reference conditioning
//  (see EditCommand.swift) and Flux2LoRALoaderCLI's LoRA-at-init fusion (see
//  StyleCommand.swift).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct FaceSwap: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "faceswap",
            abstract: "BFS face/head swap: combine Image 1's body with Image 2's face via Flux2 Klein 9B + BFS LoRA."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Target body image (Image 1). Required.")
        var body: String

        @Option(help: "Source face image to swap in (Image 2). Required.")
        var face: String

        @Option(help: "Swap mode: 'face' (keep Image 1's hairstyle) or 'head' (swap full head incl. hair).")
        var mode: String = "face"

        @Option(help: "Override the swap prompt (default: the mode's BFS template).")
        var prompt: String = ""

        /// BFS is a single-LoRA mechanism (unlike `style`'s stackable list) —
        /// mirrors image-faceswap.py's single `--lora NAME` (default resolves
        /// via models/lora/, same as Flux2LoRALoaderCLI.loadMerged with one name).
        @Option(help: "BFS LoRA name under models/lora/ (default: bfs-head-v1-klein-9b).")
        var lora: String = "bfs-head-v1-klein-9b"
        @Option(help: "LoRA application strength. Default 1.0 (the scale BFS was trained at).")
        var loraScale: Float = 1.0

        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 777
        // 2:3 portrait — matches the BFS default (python: 1024x1536) so
        // reference images aren't stretched (mflux resizes refs to the output
        // aspect ratio; mismatched ratios visibly distort the subject).
        @Option var width: Int = 1024
        @Option var height: Int = 1536
        @Option var steps: Int = 4
        @Option var cfgScale: Float = 1.0
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        @Flag var noArtifacts: Bool = false

        private static let facePrompt =
            "Referring to Images 1 and 2, replace the person's face in Image 1 " +
            "with the face from Image 2, while keeping the natural hairstyle, " +
            "natural lighting, and face skin color of the person in Image 1."
        private static let headPrompt =
            "Referring to Images 1 and 2, replace the person's face in Image 1 " +
            "with the face from Image 2, while keeping the natural hairstyle of " +
            "Image 1, natural lighting, and face skin color consistency."

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()

            guard mode == "face" || mode == "head" else {
                throw ValidationError("--mode must be 'face' or 'head' (got '\(mode)')")
            }
            let swapPrompt = prompt.isEmpty
                ? (mode == "head" ? Self.headPrompt : Self.facePrompt)
                : prompt

            print("flux2 faceswap — BFS (Flux2 Klein 9B + BFS LoRA)")
            print("  mode     : \(mode)")
            print("  body     : \(body)")
            print("  face     : \(face)")
            print("  prompt   : \(swapPrompt)")
            print("  size     : \(width)×\(height), steps: \(steps), cfg: \(cfgScale), seed: \(seed)")

            // Load + apply the BFS LoRA AT INIT TIME (single-LoRA path; reuses
            // the same stackable loader style.swift uses with a 1-element list).
            let (loraAdapters, loraNames, loraScales) = try Flux2LoRALoaderCLI.loadMerged(
                names: [lora], scales: [loraScale], logPrefix: "  lora     : ")
            if loraNames.isEmpty || loraAdapters.adapters.isEmpty {
                FileHandle.standardError.write(Data(
                    "⚠️  faceswap: no BFS LoRA adapters loaded — result will NOT be a face swap (plain Klein Edit).\n".utf8))
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

            // Image 1 = body (target), Image 2 = face (source to swap in) —
            // order matters, the swap prompt refers to them positionally.
            let imagePaths = [URL(fileURLWithPath: body), URL(fileURLWithPath: face)]

            print("  generating...")
            let (pixels, elapsed) = pipeline.generate(
                prompt: swapPrompt, imagePaths: imagePaths, seed: seed,
                height: height, width: width, steps: steps, guidance: cfgScale)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            try Flux2T2IPipeline.saveImage(pixels, to: URL(fileURLWithPath: paths.png))
            print("")
            print("✅ generated \(URL(fileURLWithPath: paths.png).lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(paths.png)")
            if loraNames.isEmpty {
                print("   note: no LoRA loaded — this is NOT a real BFS face swap.")
            }
            if !noArtifacts {
                let runConfig = RunConfig(
                    transformer: transformer, prompt: swapPrompt,
                    width: width, height: height, steps: steps, seed: seed, cfgScale: cfgScale,
                    loraPaths: loraNames, loraScale: loraScales.first ?? loraScale,
                    loraScales: loraScales,
                    textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                    quantBits: 8, quantGroupSize: 64, command: "faceswap", pipeline: "flux2")
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
