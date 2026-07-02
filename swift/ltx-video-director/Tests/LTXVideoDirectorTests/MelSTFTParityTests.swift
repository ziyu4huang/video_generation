import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.audio_vae.bwe.
/// MelSTFT (see scripts/dump_melstft_reference.py, PLAN.md's BWE work).
final class MelSTFTParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/melstft")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/melstft")
    }

    func testMelSTFT() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("melstft.safetensors"))
        let stft = MelSTFT(melBasis: arrays["mel_basis"]!, forwardBasis: arrays["forward_basis"]!, nFFT: 512, hopLength: 80)
        let actual = stft(arrays["waveform"]!)
        MLX.eval(actual)

        let expected = arrays["output"]!
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-3, "max abs diff \(diff)")
    }
}
