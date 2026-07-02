//
//  UpscaleEngine.swift
//  LTXVideoDirector
//
//  LTX-2.3's native spatial upscaler (IC-LoRA restoration + upscale LoRA
//  stack) via `run.py video restore --restore-scale`. This is LTX's own
//  latent-space spatial upscale (not a pixel-space ESRGAN pass) — see
//  --restore-scale / --upscale-lora in run.py's help. Bridged the same way
//  as I2VEngine (Phase 0 — see PLAN.md).
//

import Foundation

public struct UpscaleRequest {
    public var inputVideo: URL
    public var outputVideo: URL?
    /// Output resolution scale relative to input (1.0 = same, 2.0 = 2x).
    public var scale: Double = 2.0
    public var restorationScale: Double = 1.0
    public var upscaleScale: Double = 1.0
    public var keepAudio: Bool = true

    public init(inputVideo: URL, outputVideo: URL? = nil) {
        self.inputVideo = inputVideo
        self.outputVideo = outputVideo
    }

    func runPyArgs() -> [String] {
        var args = [
            "video", "restore",
            "--restore-input", inputVideo.path,
            "--restore-scale", String(scale),
            "--restoration-scale", String(restorationScale),
            "--upscale-scale", String(upscaleScale),
            "--no-open",
        ]
        if let outputVideo {
            args += ["--restore-output", outputVideo.path]
        }
        if !keepAudio {
            args += ["--restore-no-audio"]
        }
        return args
    }
}

public enum UpscaleEngine {
    @discardableResult
    public static func run(_ request: UpscaleRequest, stream: Bool = true) throws -> URL {
        try RunPyBridge.run(request.runPyArgs(), stream: stream)
        if let outputVideo = request.outputVideo {
            return outputVideo
        }
        let stem = request.inputVideo.deletingPathExtension().lastPathComponent
        let ext = request.inputVideo.pathExtension
        return request.inputVideo.deletingLastPathComponent()
            .appendingPathComponent("\(stem)_restored.\(ext)")
    }
}
