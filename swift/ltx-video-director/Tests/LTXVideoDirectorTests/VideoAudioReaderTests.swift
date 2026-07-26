import XCTest
import MLX
@testable import LTXVideoDirector

final class VideoAudioReaderTests: XCTestCase {
    func testReadExtractsAudioTrackMatchingSourceWAV() throws {
        let frameDir = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_frames_\(UUID().uuidString)")
        let wavURL = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_source_\(UUID().uuidString).wav")
        let mp4URL = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_test_\(UUID().uuidString).mp4")
        defer {
            try? FileManager.default.removeItem(at: frameDir)
            try? FileManager.default.removeItem(at: wavURL)
            try? FileManager.default.removeItem(at: mp4URL)
        }

        // Known source: a 0.5s 440Hz sine tone, written via the existing (already-tested) WAVWriter.
        let sampleRate = 44100
        let frameCount = sampleRate / 2
        var sine = [Float](repeating: 0, count: frameCount)
        for i in 0..<frameCount {
            sine[i] = sin(2.0 * Float.pi * 440.0 * Float(i) / Float(sampleRate))
        }
        try WAVWriter.write(channels: [sine, sine], sampleRate: sampleRate, to: wavURL)

        // Mux it into a real mp4 via the existing MP4Writer (a few solid-color frames + the WAV above).
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 12, 64, 64], key: MLXRandom.key(5)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: frameDir)
        try MP4Writer.write(frameDirectory: frameDir, audioURL: wavURL, fps: 24.0, to: mp4URL)

        let extracted = try VideoAudioReader.read(url: mp4URL)
        let original = try WAVReader.read(url: wavURL)

        XCTAssertEqual(extracted.channels.count, original.channels.count)
        // mp4 muxing may resample/re-encode — compare via correlation, not exact equality.
        let n = min(extracted.channels[0].count, original.channels[0].count)
        XCTAssertGreaterThan(n, 0)
        var dot: Float = 0, normA: Float = 0, normB: Float = 0
        for i in 0..<n {
            dot += extracted.channels[0][i] * original.channels[0][i]
            normA += extracted.channels[0][i] * extracted.channels[0][i]
            normB += original.channels[0][i] * original.channels[0][i]
        }
        let correlation = dot / (sqrt(normA) * sqrt(normB) + 1e-9)
        XCTAssertGreaterThan(correlation, 0.9, "extracted audio should closely match the source WAV muxed into the mp4")
    }

    func testReadThrowsOnVideoWithNoAudioTrack() throws {
        let frameDir = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_novideo_\(UUID().uuidString)")
        let mp4URL = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_novideo_\(UUID().uuidString).mp4")
        defer {
            try? FileManager.default.removeItem(at: frameDir)
            try? FileManager.default.removeItem(at: mp4URL)
        }
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 1, 64, 64], key: MLXRandom.key(3)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: frameDir)
        try MP4Writer.write(frameDirectory: frameDir, audioURL: nil, fps: 24.0, to: mp4URL)

        XCTAssertThrowsError(try VideoAudioReader.read(url: mp4URL)) { error in
            guard case VideoAudioReaderError.noAudioTrack = error else {
                XCTFail("expected .noAudioTrack, got \(error)"); return
            }
        }
    }
}
