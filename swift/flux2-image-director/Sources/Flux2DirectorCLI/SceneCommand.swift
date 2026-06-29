//
//  SceneCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 scene` — multi-reference, prompt-directed scene composition.
//  Takes N DISTINCT reference images + a composition prompt and generates a
//  new scene containing the referenced identities. Mirrors the ComfyUI
//  "Klein 完全体 三參考圖全能王" workflow's chained ReferenceLatent trick:
//  each reference is VAE-encoded into a conditioning latent that the Flux2
//  Klein edit transformer attends to during denoising.
//
//  The conditioning math already lives in Flux2ReferenceConditioning.prepare
//  (it loops N distinct images, gives each a distinct RoPE t_coord, and
//  concatenates the reference tokens). This command is the CLI surface that
//  feeds MULTIPLE distinct images (vs angle/style, which repeat ONE image).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct Scene: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "scene",
            abstract: "Multi-reference prompt-directed scene composition (Flux2KleinEdit multi-ref)."
        )

        @OptionGroup var globals: GlobalOptions

        /// Repeatable: --ref a.png --ref b.png --ref c.png. Each is a DISTINCT
        /// identity/subject reference (do NOT pass the same image twice unless
        /// you intend to weight it — use --ref-count-per-image for that).
        @Option(help: "Reference image (repeatable: one --ref per distinct subject/character).")
        var ref: [String]

        @Option(help: "Composition prompt describing the scene (zh-TW supported; qwen3-8b is multilingual). e.g. \"兩個角色坐在教室裡考試，表情平靜、自信\".")
        var prompt: String

        /// How many times each distinct reference is injected into the token
        /// stream. 1 = one latent per image (default). >1 weights that
        /// identity harder (analogous to angle/style's ref-count repetition).
        @Option(help: "Latent repeats per reference image (1 = one latent each; raise to weight an identity).")
        var refCountPerImage: Int = 1

        /// Background-as-canvas (Workstream 1). When set, this image becomes the
        /// SDEdit denoise canvas — its layout/POV is inherited as the actual
        /// background the characters are placed into (not just a tone steer). It
        /// is REMOVED from the identity refs and passed as the init latent.
        @Option(help: "Background image used as the denoise canvas (inherits its layout/POV). Optional.")
        var bg: String?

        @Option(help: "Denoise strength for the --bg canvas (0.3=light refine, 0.5=restyle keeping layout, 0.7=loose redraw). Default 0.55.")
        var bgStrength: Float = 0.55

        /// LoRA name(s) under models/lora/, repeatable. Multiple are
        /// rank-stacked into one merged adapter (Flux2LoRALoader.merge). The
        /// original ComfyUI workflow stacks 12; v1 loaded none.
        @Option(help: "LoRA name under models/lora/ (repeatable: --lora A --lora B stacks them).")
        var lora: [String] = []
        @Option(help: "Per-LoRA scale (repeatable, one per --lora; trailing ones default to 1.0).")
        var loraScale: [Float] = []

        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 42
        @Option var width: Int = 1024
        @Option var height: Int = 1024
        @Option var steps: Int = 6
        @Option var cfgScale: Float = 1.0
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        @Flag var noArtifacts: Bool = false

        /// Self-gate the generated output with the shared ImageGate. With
        /// --strict-gate, a FAIL (noise / blank / NaN) aborts before writing.
        @Flag(help: "Abort (exit 1) if the output FAILs the image gate.")
        var strictGate: Bool = false

        func validate() throws {
            guard !ref.isEmpty else {
                throw ValidationError("at least one --ref image is required")
            }
            guard refCountPerImage >= 1 else {
                throw ValidationError("--ref-count-per-image must be >= 1")
            }
            guard !prompt.isEmpty else {
                throw ValidationError("--prompt is required")
            }
        }

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()
            let repeats = max(1, refCountPerImage)

            // Build refPaths: each distinct image, optionally repeated to weight
            // its identity. prepare() gives every entry a distinct t_coord.
            // The --bg canvas (if any) is excluded from identity refs.
            let bgURL = bg.map { URL(fileURLWithPath: $0) }
            let distinct = ref.map { URL(fileURLWithPath: $0) }
            let refPaths: [URL] = repeats == 1
                ? distinct
                : distinct.flatMap { Array(repeating: $0, count: repeats) }

            print("flux2 scene — multi-reference prompt-directed composition")
            print("  refs       : \(distinct.count) distinct identity image(s)")
            for (i, r) in distinct.enumerated() {
                print("               [\(i + 1)] \(r.lastPathComponent)")
            }
            if repeats > 1 {
                print("  ref repeats: ×\(repeats) per image  (identity weighting)")
            }
            if let bgU = bgURL {
                print("  canvas     : \(bgU.lastPathComponent)  (SDEdit init latent, strength=\(bgStrength))")
            }
            print("  prompt     : \(prompt)")
            print("  size       : \(width)×\(height), steps: \(steps), cfg: \(cfgScale), seed: \(seed)")
            if distinct.count < 2 {
                print("  note       : only 1 reference — for multi-character scenes pass ≥ 2 distinct --ref images.")
            }
            // Honest caveat: Flux2 reference conditioning has NO index→position
            // control. Identities come from the refs; placement is prompt-driven
            // and non-deterministic — sweep seeds if a character lands wrong.
            // With --bg the background layout is locked (canvas), so only the
            // characters' placement remains prompt-driven.
            if bgURL != nil {
                print("  caveat     : background layout locked by --bg canvas; character placement still prompt-driven (sweep --seed).")
            } else {
                print("  caveat     : identities come from refs; placement is prompt-driven (sweep --seed if a subject lands wrong).")
            }

            // Load + merge LoRA adapters (optional, stackable).
            let (loraAdapters, loraNames, loraScales) = try Flux2LoRALoaderCLI.loadMerged(
                names: lora, scales: loraScale, logPrefix: "  lora     : ")
            if !loraNames.isEmpty {
                print("               merged \(loraAdapters.adapters.count) adapters from \(loraNames.count) LoRA(s)")
            }

            // Load models.
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
                prompt: prompt, imagePaths: refPaths, seed: seed,
                height: height, width: width, steps: steps, guidance: cfgScale,
                initImagePath: bgURL, denoiseStrength: bgStrength)

            // Self-gate the output (noise / blank / NaN) before saving.
            try ImageGate.check(pixels, label: "scene", strict: strictGate)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            try Flux2T2IPipeline.saveImage(pixels, to: URL(fileURLWithPath: paths.png))
            print("")
            print("✅ generated \(URL(fileURLWithPath: paths.png).lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(paths.png)")
            if !noArtifacts {
                let runConfig = RunConfig(
                    transformer: transformer, prompt: prompt,
                    width: width, height: height, steps: steps, seed: seed, cfgScale: cfgScale,
                    loraPaths: loraNames.isEmpty ? nil : loraNames,
                    loraScale: loraScales.first ?? 1.0,
                    loraScales: loraScales.isEmpty ? nil : loraScales,
                    textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                    quantBits: 8, quantGroupSize: 64, command: "scene", pipeline: "flux2")
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
