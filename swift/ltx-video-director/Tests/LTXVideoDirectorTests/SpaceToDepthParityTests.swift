import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.video_vae.sampling's
/// space_to_depth / SpaceToDepthDownsample (the VAE encoder's downsample
/// block — see scripts/dump_spacetodepthdownsample_reference.py, PLAN.md Phase 1).
final class SpaceToDepthParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/space_to_depth")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/space_to_depth")
    }

    private func assertClose(_ actual: MLXArray, _ expected: MLXArray, tol: Float = 1e-4, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.shape, expected.shape, file: file, line: line)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32))
        let maxDiff = diff.max().item(Float.self)
        XCTAssertLessThan(maxDiff, tol, "max abs diff \(maxDiff) exceeds tolerance", file: file, line: line)
    }

    func testSpaceToDepth() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("space_to_depth.safetensors"))
        let actual = VAESampling.spaceToDepth(arrays["input"]!, stride: (2, 2, 2))
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!, tol: 1e-5)
    }

    func testDownsampleWithTemporalStride() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("downsample_st2.safetensors"))
        let module = SpaceToDepthDownsample(
            weight: arrays["conv.conv.weight"]!, bias: arrays["conv.conv.bias"]!,
            inChannels: 4, outChannels: 8, stride: (2, 2, 2))
        let actual = module(arrays["input"]!)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }

    func testDownsampleSpatialOnly() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("downsample_spatial_only.safetensors"))
        let module = SpaceToDepthDownsample(
            weight: arrays["conv.conv.weight"]!, bias: arrays["conv.conv.bias"]!,
            inChannels: 4, outChannels: 8, stride: (1, 2, 2))
        let actual = module(arrays["input"]!)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }
}
