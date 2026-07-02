import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.audio_vae.audio_vae.
/// AudioAttnBlock — including the PyTorch-compatible GroupNorm(32, ...)
/// pre-norm, a new primitive for this port (reduces over H,W AND the
/// in-group channels jointly, not per-pixel). See
/// scripts/dump_audioattnblock_reference.py, PLAN.md's audio-VAE work.
final class AudioAttnBlockParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/audio_attn")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/audio_attn")
    }

    func testAttnBlockWithGroupNorm() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("attn.safetensors"))
        let block = AudioAttnBlock(
            normWeight: arrays["norm.weight"]!, normBias: arrays["norm.bias"]!,
            q: WrappedConv2d(weight: arrays["q.conv.weight"]!, bias: arrays["q.conv.bias"]!, kernelSize: 1, padding: 0, causal: false),
            k: WrappedConv2d(weight: arrays["k.conv.weight"]!, bias: arrays["k.conv.bias"]!, kernelSize: 1, padding: 0, causal: false),
            v: WrappedConv2d(weight: arrays["v.conv.weight"]!, bias: arrays["v.conv.bias"]!, kernelSize: 1, padding: 0, causal: false),
            projOut: WrappedConv2d(weight: arrays["proj_out.conv.weight"]!, bias: arrays["proj_out.conv.bias"]!, kernelSize: 1, padding: 0, causal: false))

        let actual = block(arrays["input"]!)
        MLX.eval(actual)

        let expected = arrays["output"]!
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-3, "max abs diff \(diff)")
    }
}
