import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.transformer.rope's
/// SPLIT-layout RoPE (precompute_rope_freqs + apply_rope_split) — the
/// layout all production LTX-2.3 checkpoints use. See
/// scripts/dump_rope_reference.py, PLAN.md Phase 2 (transformer start).
final class RoPEParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/rope")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/rope")
    }

    func testSplitVideoRoPE() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("split_video.safetensors"))
        guard let positionsRaw = arrays["positions"], let x = arrays["x"],
              let expectedCos = arrays["cos"], let expectedSin = arrays["sin"],
              let expected = arrays["output"] else {
            XCTFail("missing tensors")
            return
        }
        let positions = positionsRaw.asType(.int32)

        let freqs = RoPE.precomputeSplit(
            positions: positions, innerDim: 32, numHeads: 4, theta: 10000.0, maxPos: [20, 64, 64])
        MLX.eval(freqs.cos, freqs.sin)

        XCTAssertEqual(freqs.cos.shape, expectedCos.shape)
        let cosDiff = MLX.abs(freqs.cos.asType(.float32) - expectedCos.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(cosDiff, 1e-4, "cos max abs diff \(cosDiff)")
        let sinDiff = MLX.abs(freqs.sin.asType(.float32) - expectedSin.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(sinDiff, 1e-4, "sin max abs diff \(sinDiff)")

        let actual = RoPE.applySplit(x, cos: freqs.cos, sin: freqs.sin)
        MLX.eval(actual)
        XCTAssertEqual(actual.shape, expected.shape)
        let outDiff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(outDiff, 1e-4, "output max abs diff \(outDiff)")
    }
}
