import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.video_vae's
/// PerChannelStatistics.denormalize_latent (see scripts/dump_perchannelstats_reference.py).
final class PerChannelStatisticsParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/perchannelstats")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/perchannelstats")
    }

    func testDenormalizeLatent() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("denorm.safetensors"))
        let stats = PerChannelStatistics(mean: arrays["mean"]!, std: arrays["std"]!)
        let actual = stats.denormalizeLatent(arrays["latent"]!)
        MLX.eval(actual)

        let expected = arrays["output"]!
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32))
        XCTAssertLessThan(diff.max().item(Float.self), 1e-5)
    }
}
