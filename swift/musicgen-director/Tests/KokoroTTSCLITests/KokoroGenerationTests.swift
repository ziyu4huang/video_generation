import XCTest
import MLX
@testable import MLXAudioTTS

final class KokoroGenerationTests: XCTestCase {
    private static let modelRepo = "mlx-community/Kokoro-82M-bf16"

    func testEnglishVoiceGeneratesNonEmptyAudio() async throws {
        let model = try await TTS.loadModel(modelRepo: Self.modelRepo)
        let text = "Hello from Kokoro."
        let waveform = try await model.generate(
            text: text, voice: "af_heart",
            refAudio: nil, refText: nil, language: nil
        )
        let samples: [Float] = waveform.asArray(Float.self)
        XCTAssertGreaterThan(samples.count, 0, "English generation produced zero samples")
        XCTAssertEqual(model.sampleRate, 24000, "Kokoro-82M-bf16's known sample rate")
        let durationSeconds = Double(samples.count) / Double(model.sampleRate)
        let minExpected = Double(text.count) * 0.05
        let maxExpected = Double(text.count) * 2.0
        XCTAssertGreaterThan(durationSeconds, minExpected, "output shorter than plausible for \(text.count) chars (\(durationSeconds)s)")
        XCTAssertLessThan(durationSeconds, maxExpected, "output longer than plausible for \(text.count) chars (\(durationSeconds)s)")
        // At least some non-silent signal — not just a zeroed buffer.
        let maxAbs = samples.map { abs($0) }.max() ?? 0
        XCTAssertGreaterThan(maxAbs, 0.001, "English generation looks silent (max abs sample \(maxAbs))")
    }

    func testMandarinVoiceGeneratesNonEmptyAudio() async throws {
        let model = try await TTS.loadModel(modelRepo: Self.modelRepo)
        let text = "你好，這是一段測試語音。"
        let waveform = try await model.generate(
            text: text, voice: "zf_xiaobei",
            refAudio: nil, refText: nil, language: nil
        )
        let samples: [Float] = waveform.asArray(Float.self)
        XCTAssertGreaterThan(samples.count, 0, "Mandarin generation produced zero samples — check the ByT5 G2P path loaded")
        XCTAssertEqual(model.sampleRate, 24000, "Kokoro-82M-bf16's known sample rate")
        let durationSeconds = Double(samples.count) / Double(model.sampleRate)
        let minExpected = Double(text.count) * 0.05
        let maxExpected = Double(text.count) * 2.0
        XCTAssertGreaterThan(durationSeconds, minExpected, "output shorter than plausible for \(text.count) chars (\(durationSeconds)s)")
        XCTAssertLessThan(durationSeconds, maxExpected, "output longer than plausible for \(text.count) chars (\(durationSeconds)s)")
        let maxAbs = samples.map { abs($0) }.max() ?? 0
        XCTAssertGreaterThan(maxAbs, 0.001, "Mandarin generation looks silent (max abs sample \(maxAbs))")
    }
}
