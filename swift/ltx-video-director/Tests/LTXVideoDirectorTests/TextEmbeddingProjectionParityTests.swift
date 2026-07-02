import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.text_encoders.gemma.
/// feature_extractor.TextEmbeddingProjection — the projection between
/// Gemma's multi-layer hidden states and the Embeddings1DConnector.
/// See scripts/dump_textembeddingprojection_reference.py, PLAN.md's
/// text-encoder section.
final class TextEmbeddingProjectionParityTests: XCTestCase {
    private var refsDir: URL {
        // Walk up from this source file looking for test_refs/.
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/textembeddingprojection")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/textembeddingprojection")
    }

    func testProjectsHiddenStatesToVideoAndAudio() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("ref.safetensors"))
        let metaURL = refsDir.appendingPathComponent("meta.json")
        let meta = try JSONSerialization.jsonObject(with: Data(contentsOf: metaURL)) as? [String: Any]
        let embeddingDim = Float(meta?["embedding_dim"] as? Int ?? 16)

        let proj = TextEmbeddingProjection(
            videoAggregateEmbedWeight: arrays["video_aggregate_embed.weight"]!,
            videoAggregateEmbedBias: arrays["video_aggregate_embed.bias"]!,
            audioAggregateEmbedWeight: arrays["audio_aggregate_embed.weight"]!,
            audioAggregateEmbedBias: arrays["audio_aggregate_embed.bias"]!,
            embeddingDim: embeddingDim)

        let (video, audio) = proj(arrays["hidden_states"]!)
        MLX.eval(video, audio)

        let expectedV = arrays["video_output"]!
        let expectedA = arrays["audio_output"]!
        XCTAssertEqual(video.shape, expectedV.shape)
        XCTAssertEqual(audio.shape, expectedA.shape)

        let diffV = MLX.abs(video.asType(.float32) - expectedV.asType(.float32)).max().item(Float.self)
        let diffA = MLX.abs(audio.asType(.float32) - expectedA.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diffV, 1e-4, "video projection max abs diff \(diffV)")
        XCTAssertLessThan(diffA, 1e-4, "audio projection max abs diff \(diffA)")
    }
}
