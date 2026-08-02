//
//  FaceDetailCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 face-detail` — detect faces (Apple Vision), crop + pad, regenerate
//  each crop at low-denoise SDEdit strength, feathered-composite back. Port
//  of face_detailer.py's `detail_faces()` orchestration; the per-face loop
//  itself lives in Flux2Director's FaceDetailPipeline (library-level, so it
//  stays testable without ArgumentParser). Model-loading mirrors
//  StyleTransferCommand.swift exactly (same flags/defaults).
//
//  No faces detected -> the input is copied to the output unchanged, exit 0
//  (mirrors Python's "no faces detected — skipping", NOT an error).
//
//  LoRA support for the regeneration step (face_detailer.py's lora_path/
//  lora_scale) is deliberately NOT exposed — no caller in this repo's
//  current workflow usage needs it (YAGNI); see design spec's Scope
//  section.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct FaceDetail: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "face-detail",
            abstract: "Detect faces and regenerate each at higher detail (Flux2 Klein SDEdit img2img, Apple Vision detection)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Source image path.")
        var input: String

        @Option(help: "Text prompt describing the person/scene, used for face-detail regeneration.")
        var prompt: String = ""

        @Option(help: "Bounding-box expansion factor around each detected face.")
        var padding: Float = 1.8

        @Option(help: "Feather radius (px) for the composite seam.")
        var feather: Int = 20

        @Option(name: .customLong("denoise-strength"), help: "SDEdit denoise strength on each face crop (0.15 subtle .. 0.3 noticeable).")
        var denoiseStrength: Float = 0.15

        @Option(help: "Denoising steps for face regeneration.")
        var steps: Int = 9

        @Option(name: .customLong("min-confidence"), help: "Minimum Vision face-detection confidence (0-1).")
        var minConfidence: Float = 0.5

        @Option var seed: UInt64 = 42
        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Flag var noArtifacts: Bool = false

        @Flag(help: "Abort (exit 1) if the output FAILs the image gate.")
        var strictGate: Bool = false

        func validate() throws {
            guard padding > 0 else { throw ValidationError("--padding must be > 0") }
            guard denoiseStrength > 0 && denoiseStrength <= 1.0 else {
                throw ValidationError("--denoise-strength must be in (0, 1.0]")
            }
        }

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()

            print("flux2 face-detail — detect + regenerate faces")
            print("  input     : \(input)")
            print("  padding   : \(padding), feather: \(feather), denoise: \(denoiseStrength), steps: \(steps)")
            print("  min-conf  : \(minConfidence), seed: \(seed)")

            let (width, height) = try Flux2ImageLoad.imageSize(at: URL(fileURLWithPath: input))
            let rgb = try Flux2ImageLoad.loadArray(from: URL(fileURLWithPath: input), targetSize: (width, height))

            let faces = try FaceDetector.detectFaces(
                at: URL(fileURLWithPath: input), width: width, height: height, minConfidence: minConfidence)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            let imagePath = URL(fileURLWithPath: paths.png)

            guard !faces.isEmpty else {
                print("  [face-detail] No faces detected — copying input unchanged")
                try ImageSave.savePNG(rgb, to: imagePath)
                print("")
                print("✅ face-detail (no-op) \(imagePath.lastPathComponent)")
                print("   \(imagePath.path)")
                return
            }
            print("  [face-detail] Found \(faces.count) face(s)")

            print("  loading models...")
            let tfW = try Flux2TransformerWeights.load(
                dir: ModelPaths.transformerRoot.appendingPathComponent(transformer))
            let tf = Flux2Transformer.build(weights: tfW)
            let teW = try Flux2TextEncoderWeights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent(encoder))
            let te = Flux2TextEncoder.build(weights: teW)
            let tok = Flux2Tokenizer(jsonURL: ModelPaths.tokenizerRoot
                .appendingPathComponent(tokenizerDir).appendingPathComponent("tokenizer.json"))!
            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(vae)
            let vaeWeights = try Self.loadAllShards(url: vaeURL)
            let bn = Flux2BatchNormStats(
                runningMean: vaeWeights["bn.running_mean"]!,
                runningVar: vaeWeights["bn.running_var"]!)
            let pipeline = Flux2EditPipeline(
                transformer: tf, textEncoder: te, tokenizer: tok,
                vaeEncoder: Flux2VAEEncoder(weights: vaeWeights),
                vaeDecoder: Flux2VAEDecoder(weights: vaeWeights), bn: bn)

            print("  generating...")
            let start = DispatchTime.now()
            let result = try FaceDetailPipeline.detailFaces(
                image: rgb, faces: faces, prompt: prompt, pipeline: pipeline,
                seed: seed, steps: steps, denoiseStrength: denoiseStrength,
                padding: padding, feather: feather)
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9

            try ImageGate.check(result, label: "face-detail", strict: strictGate)

            try Flux2T2IPipeline.saveImage(result, to: imagePath)
            print("")
            print("✅ face-detail \(imagePath.lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(imagePath.path)")

            if !noArtifacts {
                try writeArtifacts(paths: paths, elapsed: elapsed, faceCount: faces.count, width: width, height: height)
            }
        }

        private func writeArtifacts(paths: OutputPaths, elapsed: Double, faceCount: Int, width: Int, height: Int) throws {
            let startTime = Manifest.nowISO()
            let runConfig = RunConfig(
                transformer: transformer, prompt: prompt,
                width: width, height: height, steps: steps, seed: seed, cfgScale: 1.0,
                loraPaths: nil, loraScale: 1.0, loraScales: nil,
                textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                quantBits: 8, quantGroupSize: 64, command: "face-detail", pipeline: "flux2"
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
            print("   faces:      \(faceCount)")
        }

        private static func loadAllShards(url: URL) throws -> [String: MLXArray] {
            var all: [String: MLXArray] = [:]
            let files = (try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil))
                .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for f in files { all.merge(try loadArrays(url: f)) { _, new in new } }
            return all
        }
    }
}
