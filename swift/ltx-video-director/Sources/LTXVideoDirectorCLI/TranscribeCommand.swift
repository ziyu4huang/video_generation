//
//  TranscribeCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video transcribe` — native (Swift/MLX) Whisper transcription emitting
//  the EXACT WhisperResult JSON the Bun `whisperAdapter` (s2-agent-ext-movie-
//  director) parses: { ok, audio, model, language, duration_s, text,
//  segments[{start,end,text,words[]}] }. This is the Item-I native transcriber
//  backend replacing the python `whisper_transcribe.py` → mlx_whisper spawn —
//  segment-level timestamps only in this revision; per-word DTW alignment is a
//  separate follow-up (P2b), so each segment's `words` array is empty.
//
//  Checkpoint resolution mirrors ASRGateEngine.autoDetect:
//    1. --checkpoint flag (explicit weights.safetensors path)
//    2. WHISPER_NATIVE_CHECKPOINT env
//    3. ~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/
//       snapshots/*/weights.safetensors (the large-v3-mlx HF cache)
// Dims default to large-v3 (32 enc / 32 dec / 20 heads); override via
// --n-encoder-layer / --n-decoder-layer / --n-head for other checkpoints.

import ArgumentParser
import Foundation
import LTXVideoDirector
import MLX

extension LTXVideoDirectorCLI {
    struct Transcribe: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "transcribe",
            abstract: "Native Whisper transcription → WhisperResult JSON (segment-level timestamps)."
        )

        @Option(help: "Path to the audio/video file to transcribe.")
        var audio: String

        @Option(help: "Force-decode this language (ISO 639-1, e.g. 'en', 'zh'). Default: auto-detect.")
        var language: String?

        @Option(help: "Path to whisper weights.safetensors (default: cached whisper-large-v3-mlx).")
        var checkpoint: String?

        @Option(help: "Encoder layer count (default 32 for large-v3).")
        var nEncoderLayer: Int = 32

        @Option(help: "Decoder layer count (default 32 for large-v3).")
        var nDecoderLayer: Int = 32

        @Option(help: "Attention head count (default 20 for large-v3).")
        var nHead: Int = 20

        @Option(help: "Write the WhisperResult JSON here (also printed to stdout).")
        var output: String?

        @Flag(help: "Skip per-word DTW alignment (segment-level timestamps only).")
        var noWords: Bool = false

        func run() throws {
            var payload: [String: Any] = [:]
            var hasError = false

            do {
                guard FileManager.default.fileExists(atPath: audio) else {
                    throw TranscribeError.audioNotFound(audio)
                }
                let ckpt = try TranscribeCommand.resolveCheckpoint(flag: checkpoint)
                let model = try WhisperModel.load(
                    checkpointPath: ckpt,
                    nEncoderLayer: nEncoderLayer, nDecoderLayer: nDecoderLayer, nHead: nHead
                )

                let audioURL = URL(fileURLWithPath: audio)
                let samples = try WhisperMel.loadAudio(url: audioURL)
                if samples.isEmpty {
                    throw TranscribeError.noAudioTrack(audio)
                }
                let mel = WhisperMel.logMelSpectrogram(audio: MLXArray(samples), nMels: .oneTwentyEight)

                let started = ProcessInfo.processInfo.systemUptime
                let forced = language?.trimmingCharacters(in: .whitespaces).nilIfEmpty
                let tx = model.transcribeSegments(mel: mel, forcedLanguage: forced, wordTimestamps: !noWords)
                let elapsed = ProcessInfo.processInfo.systemUptime - started

                let segs: [[String: Any]] = tx.segments.map { seg in
                    let words: [[String: Any]] = seg.words.map { w in
                        ["word": w.word, "start": w.start, "end": w.end, "probability": w.probability]
                    }
                    return ["start": seg.start, "end": seg.end, "text": seg.text, "words": words] as [String: Any]
                }
                payload = [
                    "ok": true,
                    "audio": (audioURL.path as NSString).standardizingPath,
                    "model": ckpt,
                    "language": tx.language,
                    "duration_s": Double(round(elapsed * 1000)) / 1000.0,
                    "text": tx.text,
                    "segments": segs,
                ]
            } catch {
                payload = ["ok": false, "error": "\(error)"]
                hasError = true
            }

            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            let jsonString = String(data: data, encoding: .utf8) ?? "{\"ok\":false,\"error\":\"json encode failed\"}"
            print(jsonString)
            if let output {
                try jsonString.write(toFile: output, atomically: true, encoding: .utf8)
            }
            if hasError { throw ExitCode(2) }
        }
    }
}

enum TranscribeCommand {
    /// Resolve the whisper checkpoint: --checkpoint flag > WHISPER_NATIVE_CHECKPOINT
    /// env > the cached whisper-large-v3-mlx HF snapshot. Throws if none present.
    static func resolveCheckpoint(flag: String?) throws -> String {
        if let flag, !flag.isEmpty {
            guard FileManager.default.fileExists(atPath: flag) else {
                throw TranscribeError.checkpointNotFound(flag)
            }
            return flag
        }
        if let env = ProcessInfo.processInfo.environment["WHISPER_NATIVE_CHECKPOINT"],
           FileManager.default.fileExists(atPath: env) {
            return env
        }
        let hubDir = (NSString(string: "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/snapshots").expandingTildeInPath)
        let fm = FileManager.default
        if let snapshots = try? fm.contentsOfDirectory(atPath: hubDir) {
            for snapshot in snapshots {
                let candidate = "\(hubDir)/\(snapshot)/weights.safetensors"
                if fm.fileExists(atPath: candidate) { return candidate }
            }
        }
        throw TranscribeError.checkpointNotFound("no --checkpoint, no WHISPER_NATIVE_CHECKPOINT, no cached whisper-large-v3-mlx")
    }
}

enum TranscribeError: Error, CustomStringConvertible {
    case audioNotFound(String)
    case noAudioTrack(String)
    case checkpointNotFound(String)

    var description: String {
        switch self {
        case .audioNotFound(let p): return "audio not found: \(p)"
        case .noAudioTrack(let p): return "no audio track in: \(p)"
        case .checkpointNotFound(let p): return "whisper checkpoint not found: \(p)"
        }
    }
}

extension String {
    /// Empty (after trim) → nil, so `--language "  "` is treated as auto-detect.
    var nilIfEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
