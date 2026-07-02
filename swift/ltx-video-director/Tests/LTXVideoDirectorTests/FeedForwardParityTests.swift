import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.transformer.
/// feed_forward.FeedForward (see scripts/dump_feedforward_reference.py,
/// PLAN.md Phase 2).
final class FeedForwardParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/feed_forward")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/feed_forward")
    }

    func testFeedForward() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("feed_forward.safetensors"))
        guard let input = arrays["input"], let expected = arrays["output"] else {
            XCTFail("missing tensors")
            return
        }
        let ff = FeedForward(
            projInWeight: arrays["proj_in.weight"]!, projInBias: arrays["proj_in.bias"]!,
            projOutWeight: arrays["proj_out.weight"]!, projOutBias: arrays["proj_out.bias"]!)
        let actual = ff(input)
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-4, "max abs diff \(diff)")
    }
}
