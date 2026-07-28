//
//  GenerateCommand.swift
//  MusicGenDirectorCLI
//
//  `musicgen generate` — full text-to-music generation, mirrors run.py
//  music's --prompt/--output/--duration flags for the TS bridge (Task 10).
//

import ArgumentParser
import MusicGenDirector
import Flux2Director
import Foundation
import MLX

extension MusicGenCLI {
    struct Generate: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "generate",
            abstract: "Generate music from a text prompt (pure Swift MLX MusicGen-small)."
        )

        @Option(help: "Music description prompt.")
        var prompt: String

        @Option(help: "Output .wav path.")
        var output: String

        @Option(help: "Target duration in seconds.")
        var duration: Float = 30.0

        @Option(help: "Random seed for sampling (default: nondeterministic).")
        var seed: UInt64?

        @Option(help: "musicgen-small checkpoint directory.")
        var modelDir: String = "mlx-models/musicgen/musicgen-small"

        func run() throws {
            setbuf(stdout, nil)
            let dir = URL(fileURLWithPath: modelDir)

            print("[musicgen generate] loading T5 text encoder...")
            let t5Weights = try MusicGenT5Weights.load(path: dir.appendingPathComponent("text_encoder.safetensors"))
            let t5 = MusicGenT5Encoder.build(weights: t5Weights, precision: .float32)

            print("[musicgen generate] loading LM decoder...")
            let decoderWeights = try MusicGenWeights.load(path: dir.appendingPathComponent("decoder.safetensors"))
            let decoder = try MusicGenDecoder.build(weights: decoderWeights, precision: .float32)

            print("[musicgen generate] loading EnCodec...")
            let encodec = try MusicGenEncodecAdapter(
                configPath: dir.appendingPathComponent("audio_encoder_config.json"),
                weightsPath: dir.appendingPathComponent("audio_encoder.safetensors"))

            let tokenizerURL = dir.appendingPathComponent("tokenizer.json")
            guard let tokenizer = KontextT5Tokenizer(tokenizerJSONURL: tokenizerURL) else {
                print("ERROR: could not load tokenizer.json from \(tokenizerURL.path)")
                print("Run: python/venv/bin/python python/mlx-movie-director/run.py import-musicgen")
                throw ExitCode.failure
            }

            let generator = MusicGenGenerator(tokenizer: tokenizer, t5: t5, decoder: decoder, encodec: encodec)
            let config = MusicGenGenerationConfig(duration: duration, seed: seed)

            print("[musicgen generate] generating \(duration)s of audio for: \"\(prompt)\"")
            let t0 = Date()
            let waveform = generator.generate(prompt: prompt, config: config)
            let elapsed = Date().timeIntervalSince(t0)

            try Self.writeWav(waveform: waveform, sampleRate: encodec.sampleRate, to: output)
            let attrs = try? FileManager.default.attributesOfItem(atPath: output)
            let size = (attrs?[.size] as? Int) ?? 0
            print("[musicgen generate] done in \(String(format: "%.1f", elapsed))s -> \(output) (\(size) bytes)")
        }

        private static func writeWav(waveform: MLXArray, sampleRate: Int, to path: String) throws {
            let samples: [Float] = waveform.asArray(Float.self)
            var data = Data()
            func appendLE(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
            func appendLE16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }

            let numSamples = samples.count
            let byteRate = sampleRate * 2
            data.append(contentsOf: "RIFF".utf8)
            appendLE(UInt32(36 + numSamples * 2))
            data.append(contentsOf: "WAVE".utf8)
            data.append(contentsOf: "fmt ".utf8)
            appendLE(16)
            appendLE16(1)          // PCM
            appendLE16(1)          // mono
            appendLE(UInt32(sampleRate))
            appendLE(UInt32(byteRate))
            appendLE16(2)          // block align
            appendLE16(16)         // bits per sample
            data.append(contentsOf: "data".utf8)
            appendLE(UInt32(numSamples * 2))
            for s in samples {
                let clamped = max(-1.0, min(1.0, s))
                appendLE16(UInt16(bitPattern: Int16(clamped * 32767.0)))
            }
            let outDir = (path as NSString).deletingLastPathComponent
            if !outDir.isEmpty {
                try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
            }
            try data.write(to: URL(fileURLWithPath: path))
        }
    }
}
