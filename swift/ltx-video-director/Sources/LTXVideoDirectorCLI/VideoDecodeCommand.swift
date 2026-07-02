//
//  VideoDecodeCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video video-decode` — decodes an LTX-2.3 video latent to a PNG
//  frame sequence using ONLY native Swift/MLX: VideoDecoderLoader +
//  PNGFrameWriter. No RunPyBridge, no run.py subprocess anywhere in this
//  command's path — the video-side counterpart to `audio-decode`.
//
//  `--zeros` exists for the same reason as `audio-decode`'s: a REAL
//  latent needs the transformer + Gemma-dependent denoise loop, which
//  doesn't exist natively yet. This exercises the decode half of the
//  video pipeline (no text encoder needed) independently.
//

import ArgumentParser
import Foundation
import LTXVideoDirector
import MLX

struct VideoDecode: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "video-decode",
        abstract: "Decode an LTX-2.3 video latent to a PNG frame sequence (pure Swift/MLX, no run.py)."
    )

    @Option(help: "Path to a .safetensors file containing a 'video_latent' array of shape (1, 128, F, H, W).")
    var latent: String?

    @Flag(help: "Skip loading a latent file and decode a synthetic (all-zero) latent instead — useful for exercising the pipeline before real latents exist.")
    var zeros = false

    @Option(help: "Latent frame count for the --zeros smoke-test latent.")
    var zerosFrames = 2

    @Option(help: "Latent spatial size (H=W) for the --zeros smoke-test latent.")
    var zerosSize = 2

    @Option(name: .shortAndLong, help: "Output directory for the PNG frame sequence.")
    var output: String = "video_decode_frames"

    func run() throws {
        guard zeros || latent != nil else {
            throw ValidationError("Provide --latent <file> or pass --zeros for a smoke test.")
        }

        let videoLatent: MLXArray
        if zeros {
            videoLatent = MLXArray.zeros([1, 128, zerosFrames, zerosSize, zerosSize]).asType(.float32)
            print("Using a synthetic all-zero latent: (1, 128, \(zerosFrames), \(zerosSize), \(zerosSize))")
        } else {
            let latentURL = URL(fileURLWithPath: latent!)
            let arrays = try MLX.loadArrays(url: latentURL)
            guard let loaded = arrays["video_latent"] else {
                throw ValidationError("'\(latentURL.path)' has no 'video_latent' key. Keys found: \(arrays.keys.sorted())")
            }
            videoLatent = loaded.asType(.float32)
            print("Loaded video latent: \(videoLatent.shape) from \(latentURL.path)")
        }

        print("Loading native VideoDecoder (no run.py)...")
        let decoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        let decoder = try VideoDecoderLoader.loadReal(checkpointURL: decoderURL)

        print("Decoding latent -> pixels (native VideoDecoder)...")
        let pixels = decoder(videoLatent)  // (1, 3, T, H, W), [-1, 1]
        MLX.eval(pixels)
        print("  pixel shape: \(pixels.shape)")

        let outputURL = URL(fileURLWithPath: output)
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: outputURL)
        print("Wrote \(frameCount) PNG frames to \(outputURL.path) — 100% native Swift/MLX, zero run.py calls.")
    }
}
