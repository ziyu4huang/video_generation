import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.video_vae.resnet.ResBlockStage
/// (see scripts/dump_resblock_reference.py, PLAN.md Phase 1).
final class ResBlockStageParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/resblock")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/resblock")
    }

    func testStageTwoBlocks() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("stage_2blocks.safetensors"))
        guard let input = arrays["input"], let expected = arrays["output"] else {
            XCTFail("missing input/output tensors")
            return
        }
        let stage = ResBlockStage(weights: arrays, numBlocks: 2, causal: true, spatialPaddingMode: "zeros")
        let actual = stage(input)
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32))
        let maxDiff = diff.max().item(Float.self)
        XCTAssertLessThan(maxDiff, 1e-4, "max abs diff \(maxDiff) exceeds tolerance")
    }
}
