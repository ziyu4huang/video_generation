import XCTest
import MLX
@testable import LTXVideoDirector

/// Real-checkpoint smoke test for NativeTextEncodeStage — the composition
/// of GemmaTokenizer -> GemmaEncoder -> TextEmbeddingProjection ->
/// Embeddings1DConnector (video + audio). Each piece already has its own
/// parity test against the real Python reference (GemmaFullEncoderParityTests,
/// TextEmbeddingProjectionParityTests, EmbeddingsConnectorParityTests); this
/// test confirms the ASSEMBLY loads the real production checkpoints and
/// produces finite, correctly-shaped conditioning embeds end to end — no
/// reference to diff against here (there is no single Python entry point
/// that runs exactly this composition), matching the "integration smoke
/// test, not a numerical parity check" pattern established by
/// VideoDecoderRealCheckpointTests/LTXModelRealCheckpointTests.
final class NativeTextEncodeStageRealCheckpointTests: XCTestCase {
    func testEncodeProducesFiniteCorrectlyShapedEmbeds() throws {
        // Short maxLength keeps this fast — the full 48-layer Gemma stream
        // + connector run is O(seconds) at maxLength=32 vs the production
        // default of 1024.
        let stage = NativeTextEncodeStage(maxLength: 32)
        let result = try stage.encode("a beautiful young woman standing on a city street")

        // seqLen (32) + numRegisters (128, confirmed via learnable_registers
        // shape in ConnectorCheckpointLoader's header) = 160.
        XCTAssertEqual(result.videoEmbeds.shape, [1, 160, 4096])
        XCTAssertEqual(result.audioEmbeds.shape, [1, 160, 2048])

        let videoFinite = MLX.all(MLX.isFinite(result.videoEmbeds)).item(Bool.self)
        let audioFinite = MLX.all(MLX.isFinite(result.audioEmbeds)).item(Bool.self)
        XCTAssertTrue(videoFinite, "video embeds contain non-finite values")
        XCTAssertTrue(audioFinite, "audio embeds contain non-finite values")
    }
}
