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

        /// WS3 — per-reference strength. Repeatable, one per --ref (trailing
        /// default 1.0). Scales each reference's conditioning token values so one
        /// identity can be weighted harder than another.
        @Option(help: "Per-reference strength (repeatable, one per --ref; default 1.0). Weight one identity over another.")
        var refStrength: [Float] = []

        /// WS3 — timestep gating. Inject reference tokens only in the early
        /// fraction of steps (t/steps < gate); after, the model finishes the
        /// scene without the refs' pull. 1.0 = inject all steps (default).
        @Option(help: "Inject refs only in the first fraction of steps (0.5 = first half). Default 1.0.")
        var refGateSteps: Float = 1.0

        /// Regional placement (Workstream 1b). Flux2KleinEdit conditions on
        /// GLOBAL ref tokens — there is no identity→spatial-region binding, so
        /// left/right placement is otherwise prompt-driven (non-deterministic).
        /// `--regional` adds a post-pass: after the base scene, each distinct
        /// ref is identity-refined into its own vertical strip via masked inpaint
        /// (the rest of the scene is locked). ref[0]→leftmost strip, etc.
        @Flag(help: "Regional placement: refine each ref into a vertical strip (left→right) via masked inpaint. Fixes left/right assignment.")
        var regional: Bool = false
        @Option(help: "Seam feather (px) for regional strip inpaint. Default 24.")
        var regionalFeather: Int = 24
        /// Regional SDEdit strength. The strip is refined via PARTIAL denoise
        /// (start from the existing scene, lightly re-denoise) so identity is
        /// nudged without fully re-rolling hands — the failure mode that made
        /// `--regional` net-negative at strength 1.0. 0.3 = barely touch,
        /// 0.45 = light identity refine (default), 0.7 = loose redraw (hands
        /// start to degrade). < 1.0 enables the SDEdit path.
        @Option(help: "Regional refine strength (SDEdit). 0.45 = light identity nudge preserving hands; 1.0 = full regen (re-rolls hands). Default 0.45.")
        var regionalStrength: Float = 0.45

        /// Hand-repair post-pass. The hardest generation artifact is hands
        /// (fused/extra fingers) — a known platform ceiling. This is a genuine
        /// scene-side mitigation: SAM3 text-segments "hands" in the result, and
        /// the hand region is re-denoised (inpaint) from the prompt so deformed
        /// hands are regenerated. Best-effort: regeneration can itself produce
        /// new defects, but it lets the model retry the hand zone specifically.
        @Flag(help: "Repair hands: SAM3-segment 'hands' then re-denoise that region (best-effort fix for fused/extra fingers).")
        var handRepair: Bool = false
        @Option(help: "Hand-repair denoise strength. 0.6 = conservative, 0.8 = stronger regen (default). Above 0.8 risks new hand chaos.")
        var handRepairStrength: Float = 0.8

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
            guard refStrength.count <= distinctCount() else {
                throw ValidationError("--ref-strength count (\(refStrength.count)) exceeds --ref count (\(distinctCount()))")
            }
        }

        /// Number of distinct --ref images (before repeat expansion), for validation.
        private func distinctCount() -> Int { ref.count }

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

            // WS3: per-reference strengths expand with the repeat pattern so they
            // align with refPaths (prepare() indexes by image order). Trailing
            // distinct refs without an explicit strength default to 1.0.
            let refStrengths: [Float]? = refStrength.isEmpty ? nil : distinct.flatMap { d -> [Float] in
                let i = distinct.firstIndex(of: d) ?? 0
                let s = i < refStrength.count ? refStrength[i] : 1.0
                return Array(repeating: s, count: repeats)
            }
            if let rs = refStrengths, rs.contains(where: { $0 != 1.0 }) {
                print("  ref strength: \(refStrength.enumerated().map { "\($0.offset)=\(refStrength[$0.offset])" }.joined(separator: ", "))  (per distinct ref)")
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
            let (basePixels, baseElapsed) = pipeline.generate(
                prompt: prompt, imagePaths: refPaths, seed: seed,
                height: height, width: width, steps: steps, guidance: cfgScale,
                initImagePath: bgURL, denoiseStrength: bgStrength,
                refStrengths: refStrengths, refGateSteps: refGateSteps)

            // Regional placement post-pass (Workstream 1b): refine each distinct
            // ref into its own vertical strip via masked inpaint, locking the
            // rest. Enforces left→right identity assignment that the global-token
            // conditioning can't otherwise provide.
            var pixels = basePixels
            var elapsed = baseElapsed
            if regional {
                print("  regional : refining \(distinct.count) ref(s) into vertical strips (feather=\(regionalFeather), strength=\(regionalStrength))")
                for (i, ref) in distinct.enumerated() {
                    let mask = verticalStripMask(
                        width: width, height: height, index: i,
                        count: distinct.count, feather: regionalFeather)
                    let (refined, t) = pipeline.inpaint(
                        prompt: prompt, sourcePixels: pixels, sourceMask: mask,
                        referencePath: ref, seed: seed &+ UInt64(i + 1),
                        steps: steps, guidance: cfgScale,
                        width: width, height: height, feather: regionalFeather,
                        denoiseStrength: regionalStrength)
                    pixels = refined
                    elapsed += t
                    print("            [\(i + 1)/\(distinct.count)] \(ref.lastPathComponent) → strip \(i + 1)/\(distinct.count)")
                }
            }

            // Hand-repair post-pass (scene-side mitigation for the hands ceiling):
            // SAM3 text-segments "hands", then the hand region is re-denoised from
            // the prompt so fused/extra fingers get a regeneration retry.
            if handRepair {
                let tmpImg = NSTemporaryDirectory() + "flux2_handrepair_\(getpid()).png"
                let maskPath = NSTemporaryDirectory() + "flux2_handmask_\(getpid()).png"
                try Flux2T2IPipeline.saveImage(pixels, to: URL(fileURLWithPath: tmpImg))
                var repoRoot = FileManager.default.currentDirectoryPath
                while !FileManager.default.fileExists(atPath: (repoRoot as NSString).appendingPathComponent("python/venv/bin/python")) {
                    repoRoot = (repoRoot as NSString).deletingLastPathComponent
                }
                print("  hand-repair: SAM3-segmenting 'hands'...")
                try runSAM3Bridge(repoRoot: repoRoot, image: tmpImg, prompt: "hands",
                                  threshold: 0.3, outMask: maskPath)
                // Detection count is in maskPath + ".json" (skip if nothing found).
                let count = detectionCount(maskPath + ".json")
                if count == 0 {
                    print("            no hands detected — skipping repair")
                } else {
                    let handMask = try Flux2ImageLoad.loadMaskAsChannel(
                        from: URL(fileURLWithPath: maskPath), width: width, height: height)
                    let handPrompt = prompt + ", detailed natural human hands with five correct fingers on each hand"
                    let (refined, t) = pipeline.inpaint(
                        prompt: handPrompt, sourcePixels: pixels, sourceMask: handMask,
                        referencePath: nil, seed: seed &+ 999,
                        steps: steps, guidance: cfgScale,
                        width: width, height: height, feather: 16,
                        denoiseStrength: handRepairStrength)
                    pixels = refined
                    elapsed += t
                    print("            repaired \(count) hand region(s) (strength=\(handRepairStrength))")
                }
            }

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

        /// SAM3 text-segmentation bridge (mirrors SwapCommand/SegmentCommand).
        private func runSAM3Bridge(repoRoot: String, image: String, prompt: String,
                                   threshold: Float, outMask: String) throws {
            let bridge = (repoRoot as NSString)
                .appendingPathComponent("python/mlx-movie-director/app/tests/sam3_segment_bridge.py")
            let python = (repoRoot as NSString).appendingPathComponent("python/venv/bin/python")
            let p = Process()
            p.executableURL = URL(fileURLWithPath: python)
            p.arguments = [bridge, "--image", image, "--prompt", prompt,
                           "--out-mask", outMask, "--threshold", String(threshold)]
            try p.run()
            p.waitUntilExit()
            if p.terminationStatus != 0 {
                throw NSError(domain: "scene", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "SAM3 bridge failed (hand-repair)"])
            }
        }

        /// Read the detection count the SAM3 bridge writes next to the mask.
        private func detectionCount(_ jsonPath: String) -> Int {
            guard let data = FileManager.default.contents(atPath: jsonPath),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return 0
            }
            if let n = obj["count"] as? Int { return n }
            if let arr = obj["detections"] as? [Any] { return arr.count }
            return 0
        }

        private func loadAllShards(url: URL) throws -> [String: MLXArray] {
            var all: [String: MLXArray] = [:]
            let files = (try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil))
                .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for f in files { all.merge(try loadArrays(url: f)) { _, new in new } }
            return all
        }

        /// Vertical-strip placement mask (1,1,H,W): 1.0 over strip `index` of
        /// `count` equal-width columns, feathered at the interior seams (image
        /// left/right edges are full-weight so borders stay exact). Adjacent
        /// strips' ramps form a partition of unity over the seam.
        private func verticalStripMask(width: Int, height: Int, index: Int,
                                       count: Int, feather: Int) -> MLXArray {
            let x0 = (width * index) / count
            let x1 = (width * (index + 1)) / count
            let ramp = max(1, feather)
            var col = [Float](repeating: 0.0, count: width)
            for x in x0..<x1 { col[x] = 1.0 }
            // feather the interior seams (not the image border sides).
            if index > 0 {
                for k in 0..<min(ramp, (x1 - x0) / 2) {
                    col[x0 + k] = Float(k + 1) / Float(ramp + 1)
                }
            }
            if index < count - 1 {
                let half = min(ramp, (x1 - x0) / 2)
                for k in 0..<half {
                    col[x1 - 1 - k] = Float(k + 1) / Float(ramp + 1)
                }
            }
            let row = MLXArray(col).asType(.float32)                 // (W,)
            let plane = MLX.broadcast(row.reshaped([1, 1, 1, width]),
                                      to: [1, 1, height, width])     // (1,1,H,W)
            return plane.asType(.float32)
        }
    }
}
