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

        @Option(help: "Stage-1 denoising steps override (run.py default: 8; voice tuning notes recommend 16 for intelligible speech).")
        var stage1Steps: Int?

        @Option(help: "Stage-2 refinement steps override (run.py default: 3).")
        var stage2Steps: Int?

        @Option(help: "Text guidance scale override.")
        var cfgScale: Double?

        @Option(help: "Spatial-temporal guidance scale override (0.0 kills motion — this is why --transformer distilled often looks static).")
        var stgScale: Double?

        @Flag(inversion: .prefixedNo, help: "Run run.py's built-in quality-check gate (auto-retry on failure).")
        var qualityCheck = true

        @Flag(inversion: .prefixedNo, help: "Also run run.py's VLM keyframe scoring.")
        var vlmScore = true

        @Flag(help: "Run the native VideoGate + VLM verify on the result after generation.")
        var selfVerify = false

        @Option(help: "Write a JSON timing/result summary to this path (for report generation).")
        var jsonOut: String?

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
            request.stage1Steps = stage1Steps
            request.stage2Steps = stage2Steps
            request.cfgScale = cfgScale
            request.stgScale = stgScale

            print("→ generating \(request.frames) frames (~\(String(format: "%.1f", Double(request.frames) / fps))s @ \(fps)fps) with transformer=\(transformer.rawValue)")
            let wallStart = Date()
            let result = try I2VEngine.generate(request)
            let wallSeconds = Date().timeIntervalSince(wallStart)
            print("\n✅ output dir: \(result.outputDir.path)")
            print("   wall time: \(String(format: "%.1f", wallSeconds))s")

            var gateVerdict: VideoGateVerdict?
            if let video = result.videoPath {
                print("   video: \(video.path)")
                if selfVerify {
                    let v = try VideoGate.evaluate(videoURL: video)
                    gateVerdict = v
                    print("   gate: \(v.status) — \(v.reasons.joined(separator: "; "))")
                }
            } else {
                print("   ⚠️  could not locate the output .mp4 in the manifest")
            }

            if let jsonOut {
                var payload: [String: Any] = [
                    "wall_seconds": wallSeconds,
                    "output_dir": result.outputDir.path,
                    "video_path": result.videoPath?.path as Any,
                    "frames": request.frames,
                    "fps": request.fps,
                    "transformer": transformer.rawValue,
                    "manifest": result.manifest,
                ]
                if let v = gateVerdict, let data = try? JSONEncoder().encode(v),
                   let obj = try? JSONSerialization.jsonObject(with: data) {
                    payload["gate"] = obj
                }
                let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: URL(fileURLWithPath: jsonOut))
            }
        }
    }
}

extension LTXTransformerVariant: ExpressibleByArgument {}
