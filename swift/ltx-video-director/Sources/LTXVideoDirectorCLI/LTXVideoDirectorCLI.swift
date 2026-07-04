//
//  LTXVideoDirectorCLI.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video` — Swift front-end for LTX-2.3 I2V generation + the native
//  video/image/voice quality gateway. See swift/ltx-video-director/PLAN.md.
//
//    i2v           — beauty-girl-on-street I2V (ZImage T2I -> VLM prompt -> LTX I2V)
//    native-i2v    — PURE SWIFT (no run.py): experimental end-to-end I2V (NativeI2VStage)
//    native-upscale — PURE SWIFT (no run.py): 2x spatial upscale via LatentUpsampler
//    native-t2a    — PURE SWIFT (no run.py): text-to-audio ONLY, no video (NativeT2AStage)
//    gate          — basic (VLM-free) video/image/voice quality gateway
//    verify        — VLM keyframe verification (semantic prompt-adherence check)
//    upscale       — LTX's native spatial upscaler (IC-LoRA restore + upscale)
//    models        — list installed LTX-2.3 transformer variants
//    audio-decode  — PURE SWIFT (no run.py): audio latent -> 48kHz WAV
//    video-decode  — PURE SWIFT (no run.py): video latent -> PNG frame sequence
//    t2i           — PURE SWIFT (no run.py): prompt -> image (ZImageDirector in-process)
//

import ArgumentParser

@main
struct LTXVideoDirectorCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "ltx-video",
        abstract: "LTX-2.3 I2V generation + video/image/voice quality gateway (Apple Silicon MLX).",
        version: "0.1.0",
        subcommands: [I2V.self, NativeI2V.self, NativeT2A.self, Gate.self, Verify.self, Upscale.self, NativeUpscale.self, Models.self, AudioDecode.self, VideoDecode.self, T2I.self]
    )
}
