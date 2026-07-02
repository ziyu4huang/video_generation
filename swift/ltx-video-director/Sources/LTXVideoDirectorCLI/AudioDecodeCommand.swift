//
//  AudioDecodeCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video audio-decode` — decodes an LTX-2.3 audio latent to a 48kHz
//  stereo WAV file using ONLY native Swift/MLX: AudioVAEDecoderLoader +
//  VocoderWithBWELoader + WAVWriter. No RunPyBridge, no run.py subprocess
//  anywhere in this command's path — this is the first CLI command in
//  this package backed entirely by the native port (see PLAN.md's
//  "Milestone: full VocoderWithBWE" section for what's been verified).
//
//  `--zeros` exists because generating a REAL latent requires the LTX
//  transformer + denoise loop, which in turn requires real text
//  embeddings from Gemma (still bridged, see PLAN.md) — this command
//  exercises the decode HALF of the pipeline (which needs no text
//  encoder at all) independently, so it can be used and tested today
//  without waiting on the Gemma bridge.
//

import ArgumentParser
import Foundation
import LTXVideoDirector
import MLX

struct AudioDecode: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "audio-decode",
        abstract: "Decode an LTX-2.3 audio latent to a 48kHz stereo WAV file (pure Swift/MLX, no run.py)."
    )

    @Option(help: "Path to a .safetensors file containing an 'audio_latent' array of shape (1, 8, T, 16).")
    var latent: String?

    @Flag(help: "Skip loading a latent file and decode a silent (all-zero) latent instead — useful for exercising the pipeline before real latents exist.")
    var zeros = false

    @Option(help: "Frame count for the --zeros smoke-test latent.")
    var zerosFrames = 8

    @Option(name: .shortAndLong, help: "Output WAV path.")
    var output: String = "audio_decode_output.wav"

    func run() throws {
        guard zeros || latent != nil else {
            throw ValidationError("Provide --latent <file> or pass --zeros for a smoke test.")
        }

        let audioLatent: MLXArray
        if zeros {
            audioLatent = MLXArray.zeros([1, 8, zerosFrames, 16]).asType(.float32)
            print("Using a synthetic all-zero latent: (1, 8, \(zerosFrames), 16)")
        } else {
            let latentURL = URL(fileURLWithPath: latent!)
            let arrays = try MLX.loadArrays(url: latentURL)
            guard let loaded = arrays["audio_latent"] else {
                throw ValidationError("'\(latentURL.path)' has no 'audio_latent' key. Keys found: \(arrays.keys.sorted())")
            }
            audioLatent = loaded.asType(.float32)
            print("Loaded audio latent: \(audioLatent.shape) from \(latentURL.path)")
        }

        print("Loading native AudioVAEDecoder (no run.py)...")
        let decoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        let decoder = try AudioVAEDecoderLoader.loadReal(checkpointURL: decoderURL)

        print("Loading native VocoderWithBWE (no run.py)...")
        let vocoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/vocoder.safetensors")
        let vocoder = try VocoderWithBWELoader.loadReal(checkpointURL: vocoderURL)

        print("Decoding latent -> mel (native AudioVAEDecoder)...")
        let mel = decoder(audioLatent)  // (1, 2, T', 64)
        MLX.eval(mel)
        print("  mel shape: \(mel.shape)")

        print("Decoding mel -> 48kHz waveform (native VocoderWithBWE)...")
        let waveform = vocoder(mel)  // (1, 2, T_audio)
        MLX.eval(waveform)
        print("  waveform shape: \(waveform.shape)")

        let numChannels = waveform.dim(1)
        let numFrames = waveform.dim(2)
        var channels: [[Float]] = []
        for c in 0..<numChannels {
            channels.append(waveform[0, c, 0...].asArray(Float.self))
        }
        let outputURL = URL(fileURLWithPath: output)
        try WAVWriter.write(channels: channels, sampleRate: 48000, to: outputURL)
        print("Wrote \(numFrames) frames (\(numChannels)ch, 48kHz) to \(outputURL.path) — 100% native Swift/MLX, zero run.py calls.")
    }
}
