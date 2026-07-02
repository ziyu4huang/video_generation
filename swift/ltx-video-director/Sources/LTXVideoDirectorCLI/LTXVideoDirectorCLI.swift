//
//  LTXVideoDirectorCLI.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video` — Swift front-end for LTX-2.3 I2V generation + the native
//  video/image/voice quality gateway. See swift/ltx-video-director/PLAN.md.
//
//    i2v           — beauty-girl-on-street I2V (ZImage T2I -> VLM prompt -> LTX I2V)
//    gate          — basic (VLM-free) video/image/voice quality gateway
//    verify        — VLM keyframe verification (semantic prompt-adherence check)
//    upscale       — LTX's native spatial upscaler (IC-LoRA restore + upscale)
//    models        — list installed LTX-2.3 transformer variants
//    audio-decode  — PURE SWIFT (no run.py): audio latent -> 48kHz WAV
//    video-decode  — PURE SWIFT (no run.py): video latent -> PNG frame sequence
//

import ArgumentParser

@main
struct LTXVideoDirectorCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "ltx-video",
        abstract: "LTX-2.3 I2V generation + video/image/voice quality gateway (Apple Silicon MLX).",
        version: "0.1.0",
        subcommands: [I2V.self, Gate.self, Verify.self, Upscale.self, Models.self, AudioDecode.self, VideoDecode.self]
    )
}
