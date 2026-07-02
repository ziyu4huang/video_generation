import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.video_vae.sampling's
/// pixel_shuffle_3d/unpatchify_spatial (see scripts/dump_sampling_reference.py).
final class VAESamplingParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/sampling")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/sampling")
    }

    private func assertClose(_ actual: MLXArray, _ expected: MLXArray, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.shape, expected.shape, file: file, line: line)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32))
        let maxDiff = diff.max().item(Float.self)
        XCTAssertLessThan(maxDiff, 1e-5, "max abs diff \(maxDiff) exceeds tolerance", file: file, line: line)
    }

    func testPixelShuffleSF2TF2() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("pixel_shuffle_sf2_tf2.safetensors"))
        let actual = VAESampling.pixelShuffle3D(arrays["input"]!, spatialFactor: 2, temporalFactor: 2)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }

    func testPixelShuffleSF2TF1() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("pixel_shuffle_sf2_tf1.safetensors"))
        let actual = VAESampling.pixelShuffle3D(arrays["input"]!, spatialFactor: 2, temporalFactor: 1)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }

    func testUnpatchifyPatchSize4() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("unpatchify_ps4.safetensors"))
        let actual = VAESampling.unpatchifySpatial(arrays["input"]!, patchSize: 4)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }
}
