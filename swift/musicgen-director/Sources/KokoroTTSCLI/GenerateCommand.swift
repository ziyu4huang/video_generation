//
//  GenerateCommand.swift
//  KokoroTTSCLI
//
//  `kokoro-tts generate` — synthesize speech from text via local Kokoro-82M.
//

import ArgumentParser
import MLXAudioTTS
import MLX
import Foundation

extension KokoroTTSCLI {
    struct Generate: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "generate",
            abstract: "Synthesize speech from text via local Kokoro-82M."
        )

        @Option(help: "Narration text.")
        var text: String

        @Option(help: "Kokoro voice id (e.g. af_heart, am_michael, zf_xiaobei, zm_yunjian).")
        var voice: String

        @Option(help: "Output .wav path.")
        var output: String

        @Option(help: "Speech speed multiplier.")
        var speed: Float = 1.0

        @Option(help: "mlx-audio-swift model repo id.")
        var modelRepo: String = "mlx-community/Kokoro-82M-bf16"

        func run() async throws {
            setbuf(stdout, nil)
            print("[kokoro-tts generate] loading \(modelRepo)...")
            let model = try await TTS.loadModel(modelRepo: modelRepo)
            if let kokoro = model as? KokoroModel {
                kokoro.speed = speed
            }

            print("[kokoro-tts generate] synthesizing (\(text.count) chars, voice=\(voice))...")
            let t0 = Date()
            let waveform = try await model.generate(
                text: text, voice: voice, refAudio: nil, refText: nil, language: nil
            )
            let elapsed = Date().timeIntervalSince(t0)

            try Self.writeWav(waveform: waveform, sampleRate: model.sampleRate, to: output)
            let attrs = try? FileManager.default.attributesOfItem(atPath: output)
            let size = (attrs?[.size] as? Int) ?? 0
            print("[kokoro-tts generate] done in \(String(format: "%.1f", elapsed))s -> \(output) (\(size) bytes)")
        }

        // Mirrors MusicGenDirectorCLI/GenerateCommand.swift's writeWav exactly
        // (16-bit PCM mono WAV) — small, self-contained, not worth sharing
        // across two independent CLI targets for one ~25-line helper.
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
