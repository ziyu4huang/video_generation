//
//  VerifyEncodecCommand.swift
//  MusicGenDirectorCLI
//
//  `musicgen verify-encodec` — decode the SAME fixed codebook indices
//  gen_musicgen_encodec_ref.py used and compare waveforms (cosine).
//

import ArgumentParser
import MusicGenDirector
import Foundation
import MLX

extension MusicGenCLI {
    struct VerifyEncodec: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-encodec",
            abstract: "Compare Swift MusicGenEncodecAdapter decode against the real HF EncodecModel reference."
        )

        @Option(help: "audio_encoder_config.json from run.py import-musicgen.")
        var config: String = "mlx-models/musicgen/musicgen-small/audio_encoder_config.json"

        @Option(help: "audio_encoder.safetensors from run.py import-musicgen.")
        var weights: String = "mlx-models/musicgen/musicgen-small/audio_encoder.safetensors"

        @Option(help: "Reference safetensors from gen_musicgen_encodec_ref.py.")
        var ref: String = "swift/musicgen-director/verify_refs/musicgen_encodec_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("musicgen verify-encodec — EnCodec 32kHz decode numeric-parity checkpoint")

            let configURL = URL(fileURLWithPath: config)
            let weightsURL = URL(fileURLWithPath: weights)
            guard FileManager.default.fileExists(atPath: weightsURL.path) else {
                print("ERROR: weights not found at \(weightsURL.path)")
                print("Run: python/venv/bin/python python/mlx-movie-director/run.py import-musicgen")
                throw ExitCode.failure
            }

            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it: python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_encodec_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)
            let codes = refTensors["codes"]!.asType(.int32)     // (4, 100) — SAME indices Python decoded
            let refWaveform = refTensors["waveform"]!.asType(.float32)
            MLX.eval(codes, refWaveform)

            let adapter = try MusicGenEncodecAdapter(configPath: configURL, weightsPath: weightsURL)
            print("frameRate=\(adapter.frameRate) sampleRate=\(adapter.sampleRate)")
            print("config: useCausalConv=\(adapter.codec.config.useCausalConv) useConvShortcut=\(adapter.codec.config.useConvShortcut)")

            let waveform = adapter.decode(codes: codes).reshaped([-1]).asType(.float32)
            print("swift waveform: \(waveform.shape)   ref: \(refWaveform.shape)")

            let n = min(waveform.dim(0), refWaveform.dim(0))
            let a = waveform[0..<n]
            let b = refWaveform[0..<n]
            let cos = cosine(a, b)
            print("[waveform cos]  \(String(format: "%.5f", cos))")

            if cos >= threshold {
                print("\n✅ MUSICGEN ENCODEC MATCHES PYTHON (threshold=\(threshold))")
            } else {
                print("\n❌ MusicGen EnCodec diverges (cos=\(String(format: "%.5f", cos)), threshold=\(threshold))")
                throw ExitCode.failure
            }
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            return (dot / (na * nb + 1e-12)).item(Float.self)
        }
    }
}
