//
//  LTXVideoDirectorCLI.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video` — Swift front-end for LTX-2.3 I2V generation + the native
//  video/image/voice quality gateway. See swift/ltx-video-director/PLAN.md.
//
//    i2v           — beauty-girl-on-street I2V (ZImage T2I -> VLM prompt -> LTX I2V)
//    native-i2v    — PURE SWIFT (no run.py): experimental end-to-end I2V (NativeI2VStage)
//    native-relay  — PURE SWIFT (no run.py, no ffmpeg): multi-segment prompt-relay (NativeRelayStage)
//    native-storyboard — PURE SWIFT (no run.py, no ffmpeg): JSON-config-driven storyboard,
//                        dispatches to native-i2v (camera-move) or native-relay (hard-cut)
//    native-upscale — PURE SWIFT (no run.py): 2x spatial upscale via LatentUpsampler
//    native-restyle — PURE SWIFT (no run.py): V2V restyle via a user-supplied IC-LoRA
//    native-t2a    — PURE SWIFT (no run.py): text-to-audio ONLY, no video (NativeT2AStage)
//    vbvr          — I2V/T2V generation with the VBVR reasoning LoRA (`run.py video vbvr` parity)
//    gate          — basic (VLM-free) video/image/voice quality gateway
//    asr-gate      — standalone ASR voice-content gate (`run.py video asr-gate` parity)
//    review        — A/B video reviewer viewer generator (`run.py video review --inputs` parity)
//    compare       — pipeline A/B comparison matrix + review (`run.py video compare` parity)
//    quality       — no-reference video quality metrics (`run.py video quality` analyze-mode parity)
//    verify        — VLM keyframe verification (semantic prompt-adherence check)
//    upscale       — LTX's native spatial upscaler (IC-LoRA restore + upscale)
//    models        — list installed LTX-2.3 transformer variants
//    audio-decode  — PURE SWIFT (no run.py): audio latent -> 48kHz WAV
//    video-decode  — PURE SWIFT (no run.py): video latent -> PNG frame sequence
//    t2i           — PURE SWIFT (no run.py): prompt -> image (ZImageDirector in-process)
//    segment       — PURE SWIFT (no run.py): scene-cut detection (VideoSceneDetector)
//

import ArgumentParser

@main
struct LTXVideoDirectorCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "ltx-video",
        abstract: "LTX-2.3 I2V generation + video/image/voice quality gateway (Apple Silicon MLX).",
        version: "0.1.0",
        subcommands: [I2V.self, NativeI2V.self, NativeRelay.self, NativeStoryboard.self, NativeT2A.self, Vbvr.self, Gate.self, AsrGate.self, Review.self, Compare.self, Quality.self, Verify.self, Upscale.self, NativeUpscale.self, NativeRestyle.self, NativeIngredients.self, Models.self, AudioDecode.self, VideoDecode.self, T2I.self, Segment.self]
    )
}
