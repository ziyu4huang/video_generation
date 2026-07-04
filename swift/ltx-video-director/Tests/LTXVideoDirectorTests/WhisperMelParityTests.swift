//
//  WhisperMelParityTests.swift
//  LTXVideoDirectorTests
//
//  Numerical parity against the REAL mlx_whisper.audio.log_mel_spectrogram
//  (python/venv has mlx_whisper installed — this dumps and compares against
//  its actual output, not a hand-derived expectation). See
//  scripts/dump_whisper_mel_reference.py + WhisperMel.swift's header comment.
//

import Foundation
import MLX
import XCTest
@testable import LTXVideoDirector

final class WhisperMelParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/whisper_mel")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/whisper_mel")
    }

    private func skipIfMissing() throws {
        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: refsDir.appendingPathComponent("whisper_mel.safetensors").path),
            "whisper_mel reference not dumped — run scripts/dump_whisper_mel_reference.py"
        )
    }

    func testLogMelSpectrogram80BinsMatchesRealMlxWhisper() throws {
        try skipIfMissing()
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("whisper_mel.safetensors"))
        let audio = arrays["audio_input"]!.asType(.float32)
        let expected = arrays["log_mel_80"]!.asType(.float32)

        let actual = WhisperMel.logMelSpectrogram(audio: audio, nMels: .eighty)
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual - expected).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-3, "n_mels=80 max abs diff \(diff)")
    }

    func testLogMelSpectrogram128BinsMatchesRealMlxWhisper() throws {
        try skipIfMissing()
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("whisper_mel.safetensors"))
        let audio = arrays["audio_input"]!.asType(.float32)
        let expected = arrays["log_mel_128"]!.asType(.float32)

        // whisper-large-v3 (the model python/mlx-movie-director's ASR gate
        // actually uses) is a 128-mel model — this is the config that matters
        // for the real bridge this port is meant to eventually replace.
        let actual = WhisperMel.logMelSpectrogram(audio: audio, nMels: .oneTwentyEight)
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual - expected).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-3, "n_mels=128 max abs diff \(diff)")
    }
}
