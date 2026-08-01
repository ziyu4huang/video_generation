import XCTest
import MLX
@testable import MLXAudioTTS

final class KokoroGenerationTests: XCTestCase {
    private static let modelRepo = "mlx-community/Kokoro-82M-bf16"

    func testEnglishVoiceGeneratesNonEmptyAudio() async throws {
        let model = try await TTS.loadModel(modelRepo: Self.modelRepo)
        let waveform = try await model.generate(
            text: "Hello from Kokoro.", voice: "af_heart",
            refAudio: nil, refText: nil, language: nil
        )
        let samples: [Float] = waveform.asArray(Float.self)
        XCTAssertGreaterThan(samples.count, 0, "English generation produced zero samples")
        XCTAssertGreaterThan(model.sampleRate, 0)
        // At least some non-silent signal — not just a zeroed buffer.
        let maxAbs = samples.map { abs($0) }.max() ?? 0
        XCTAssertGreaterThan(maxAbs, 0.001, "English generation looks silent (max abs sample \(maxAbs))")
    }

    func testMandarinVoiceGeneratesNonEmptyAudio() async throws {
        let model = try await TTS.loadModel(modelRepo: Self.modelRepo)
        let waveform = try await model.generate(
            text: "你好，這是一段測試語音。", voice: "zf_xiaobei",
            refAudio: nil, refText: nil, language: nil
        )
        let samples: [Float] = waveform.asArray(Float.self)
        XCTAssertGreaterThan(samples.count, 0, "Mandarin generation produced zero samples — check the ByT5 G2P path loaded")
        let maxAbs = samples.map { abs($0) }.max() ?? 0
        XCTAssertGreaterThan(maxAbs, 0.001, "Mandarin generation looks silent (max abs sample \(maxAbs))")
    }
}
