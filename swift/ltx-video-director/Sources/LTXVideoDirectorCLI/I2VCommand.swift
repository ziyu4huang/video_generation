//
//  I2VCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video i2v` — beauty-girl-on-street I2V, distilled model by default.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct I2V: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "i2v",
            abstract: "Generate a short I2V clip: ZImage T2I -> VLM prompt -> LTX-2.3 I2V."
        )

        @Option(help: "T2I prompt for the source image (default: beautiful girl on a city street).")
        var prompt = "a beautiful young woman standing on a bustling city street at golden hour, natural photography, detailed skin texture"

        @Option(help: "zh-TW action/speech intent for the VLM motion+voice prompt stage. Omit to skip VLM expansion.")
        var action: String? = "她微笑著轉向鏡頭，輕聲說「嗨，你好」"

        @Option(help: "Target clip duration in seconds (frame count is snapped to LTX's 8k+1 stride).")
        var seconds: Double = 10.0

        @Option(help: "Output frame rate.")
        var fps: Double = 24.0

        @Option(help: "LTX-2.3 transformer variant.")
        var transformer: LTXTransformerVariant = .defaultForI2V

        @Option(help: "Seed (omit for run.py's default).")
        var seed: Int?

        @Flag(inversion: .prefixedNo, help: "Run run.py's built-in quality-check gate (auto-retry on failure).")
        var qualityCheck = true

        @Flag(inversion: .prefixedNo, help: "Also run run.py's VLM keyframe scoring.")
        var vlmScore = true

        @Flag(help: "Run the native VideoGate + VLM verify on the result after generation.")
        var selfVerify = false

        func run() throws {
            guard LTXModelRegistry.installedVariants().contains(transformer) else {
                let installed = LTXModelRegistry.installedVariants().map(\.rawValue).joined(separator: ", ")
                throw ValidationError("transformer '\(transformer.rawValue)' not found under mlx-models/ltx-mlx/ (installed: \(installed.isEmpty ? "none" : installed))")
            }

            var request = I2VRequest(prompt: prompt, action: action)
            request.seconds = seconds
            request.fps = fps
            request.transformer = transformer
            request.seed = seed
            request.qualityCheck = qualityCheck
            request.vlmScore = vlmScore

            print("→ generating \(request.frames) frames (~\(String(format: "%.1f", Double(request.frames) / fps))s @ \(fps)fps) with transformer=\(transformer.rawValue)")
            let result = try I2VEngine.generate(request)
            print("\n✅ output dir: \(result.outputDir.path)")
            if let video = result.videoPath {
                print("   video: \(video.path)")
                if selfVerify {
                    let verdict = try VideoGate.evaluate(videoURL: video)
                    print("   gate: \(verdict.status) — \(verdict.reasons.joined(separator: "; "))")
                }
            } else {
                print("   ⚠️  could not locate the output .mp4 in the manifest")
            }
        }
    }
}

extension LTXTransformerVariant: ExpressibleByArgument {}
