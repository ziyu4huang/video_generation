//
//  UpscaleCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video upscale` — LTX-2.3's native spatial upscaler (IC-LoRA
//  restore + upscale LoRA stack), bridged via run.py video restore.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct Upscale: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "upscale",
            abstract: "Spatially upscale a video using LTX-2.3's native IC-LoRA restore+upscale stack."
        )

        @Argument(help: "Input video to upscale.")
        var input: String

        @Option(help: "Output video path (default: <input>_restored.mp4).")
        var output: String?

        @Option(help: "Output resolution scale relative to input (1.0 = same, 2.0 = 2x).")
        var scale: Double = 2.0

        @Flag(inversion: .prefixedNo, help: "Mux the original audio back into the upscaled video.")
        var keepAudio = true

        @Flag(help: "Run the native gate on the result after upscaling.")
        var selfVerify = false

        func run() throws {
            var request = UpscaleRequest(inputVideo: URL(fileURLWithPath: input))
            request.outputVideo = output.map { URL(fileURLWithPath: $0) }
            request.scale = scale
            request.keepAudio = keepAudio

            let outURL = try UpscaleEngine.run(request)
            print("\n✅ upscaled: \(outURL.path)")
            if selfVerify {
                let verdict = try VideoGate.evaluate(videoURL: outURL, expectVoice: keepAudio)
                print("   gate: \(verdict.status) — \(verdict.reasons.joined(separator: "; "))")
            }
        }
    }
}
