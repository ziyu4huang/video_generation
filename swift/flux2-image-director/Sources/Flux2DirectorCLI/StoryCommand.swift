//
//  StoryCommand.swift
//  Flux2DirectorCLI
//
//  Phase 6: `flux2 story` — generate a consistent character across multiple
//  story scenes. Generates a hero cover (T2I), then N scene views using the
//  hero as reference conditioning (identity-preserving).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct Story: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "story",
            abstract: "Character-story director: consistent character across scenes."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Character description (e.g. \"a young woman with red hair in armor\").")
        var character: String

        @Option(help: "Comma-separated scene specs. Each: \"angle:prompt\" (e.g. \"right:walking through forest,front-high:standing on a cliff\"). Default: 4 classic angles.")
        var scenes: String = ""

        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 42
        @Option var width: Int = 832
        @Option var height: Int = 1216
        @Option var steps: Int = 6
        @Option var refCount: Int = 3
        @Option var outputDir: String?
        @Option var name: String?
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        @Flag var noArtifacts: Bool = false

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()
            let storyScenes = parseScenes()
            print("flux2 story — character-story director")
            print("  character : \(character)")
            print("  scenes    : \(storyScenes.count + 1) total (1 cover + \(storyScenes.count) scenes)")
            print("  size      : \(width)×\(height), steps: \(steps), ref_count: ×\(refCount), seed: \(seed)")

            // Resolve output dir (a dedicated story folder).
            let storyName = (name ?? "story_\(Flux2StoryDirector.timestamp())") as String
            let outDir = try resolveOutputDir(storyName: storyName)
            try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
            print("  output    : \(outDir.path)")

            // Load models once (reused across all generations).
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
            let t2i = Flux2T2IPipeline(
                transformer: tf, textEncoder: te, tokenizer: tok,
                vaeDecoder: Flux2VAEDecoder(weights: vaeWeights), bn: bn)
            let edit = Flux2EditPipeline(
                transformer: tf, textEncoder: te, tokenizer: tok,
                vaeEncoder: Flux2VAEEncoder(weights: vaeWeights),
                vaeDecoder: Flux2VAEDecoder(weights: vaeWeights), bn: bn)

            // 1. Generate the hero cover (T2I, front view).
            print("")
            print("=== scene 0: cover (front view) ===")
            let coverPrompt = Flux2StoryDirector.coverPrompt(character: character)
            let (coverPixels, coverT) = t2i.generate(
                prompt: coverPrompt, seed: seed, height: height, width: width,
                steps: steps, guidance: 1.0)
            let coverPath = outDir.appendingPathComponent("cover.png")
            try Flux2T2IPipeline.saveImage(coverPixels, to: coverPath)
            print("  ✅ cover.png  (\(String(format: "%.1f", coverT))s)")

            // 2. Generate each scene using the cover as reference conditioning.
            let refPaths = Array(repeating: coverPath, count: Flux2Angle.clampRefCount(refCount))
            var scenePaths: [String] = [coverPath.path]
            for (i, scene) in storyScenes.enumerated() {
                print("")
                print("=== scene \(i + 1): \(scene.anglePreset ?? "custom") — \(scene.prompt) ===")
                let sp = Flux2StoryDirector.scenePrompt(character: character, scene: scene)
                let (pixels, t) = edit.generate(
                    prompt: sp, imagePaths: refPaths, seed: seed &+ UInt64(i + 1),
                    height: height, width: width, steps: steps, guidance: 1.0)
                let p = outDir.appendingPathComponent("scene_\(i + 1).png")
                try Flux2T2IPipeline.saveImage(pixels, to: p)
                scenePaths.append(p.path)
                print("  ✅ scene_\(i + 1).png  (\(String(format: "%.1f", t))s)")
            }

            // 3. Write a story manifest.
            let manifest: [String: Any] = [
                "character": character,
                "seed": seed,
                "width": width, "height": height, "steps": steps, "ref_count": refCount,
                "cover": coverPath.path,
                "scenes": scenePaths,
            ]
            let manifestPath = outDir.appendingPathComponent("story.json")
            try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted])
                .write(to: manifestPath)
            print("")
            print("✅ story complete: \(scenePaths.count) images in \(outDir.path)")
            print("   manifest: \(manifestPath.path)")
        }

        private func parseScenes() -> [Flux2StoryScene] {
            guard !scenes.isEmpty else { return Flux2StoryDirector.defaultScenes }
            return scenes.split(separator: "|").compactMap { spec in
                let parts = spec.split(separator: ":", maxSplits: 1)
                guard parts.count == 2 else { return nil }
                let angle = String(parts[0]).trimmingCharacters(in: .whitespaces)
                let prompt = String(parts[1]).trimmingCharacters(in: .whitespaces)
                return Flux2StoryScene(anglePreset: angle, prompt: prompt)
            }
        }

        private func resolveOutputDir(storyName: String) throws -> URL {
            let base = outputDir ?? ProcessInfo.processInfo.environment["MLX_OUTPUT_DIR"]
                ?? "../video_generation__output"
            return URL(fileURLWithPath: base).appendingPathComponent(storyName)
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

extension Flux2StoryDirector {
    /// Compact timestamp for folder naming.
    static func timestamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd_HHmmss"
        return f.string(from: Date())
    }
}
