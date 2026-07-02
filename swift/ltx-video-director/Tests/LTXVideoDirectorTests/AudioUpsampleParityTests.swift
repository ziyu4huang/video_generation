import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.audio_vae.audio_vae.
/// AudioUpsample (both causal and non-causal — the causal path drops a row
/// after the conv, changing the output height by one). See
/// scripts/dump_audioupsample_reference.py, PLAN.md's audio-VAE work.
final class AudioUpsampleParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/audio_upsample")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/audio_upsample")
    }

    private func run(_ name: String, causal: Bool) throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("\(name).safetensors"))
        let conv = WrappedConv2d(weight: arrays["conv.conv.weight"]!, bias: arrays["conv.conv.bias"]!, kernelSize: 3, padding: 1, causal: causal)
        let upsample = AudioUpsample(conv: conv, causal: causal)
        let actual = upsample(arrays["input"]!)
        MLX.eval(actual)

        let expected = arrays["output"]!
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-4, "\(name) max abs diff \(diff)")
    }

    func testCausal() throws { try run("causal", causal: true) }
    func testNonCausal() throws { try run("noncausal", causal: false) }
}
