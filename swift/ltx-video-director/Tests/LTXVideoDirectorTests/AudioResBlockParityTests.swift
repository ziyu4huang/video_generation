import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.audio_vae.audio_vae.
/// AudioResBlock (see scripts/dump_audioresblock_reference.py, PLAN.md's
/// audio-VAE work). Covers both the same-channel-causal and
/// different-channel-noncausal (with nin_shortcut) cases.
final class AudioResBlockParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/audio_resblock")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/audio_resblock")
    }

    private func assertClose(_ actual: MLXArray, _ expected: MLXArray, tol: Float = 1e-4, line: UInt = #line) {
        XCTAssertEqual(actual.shape, expected.shape, line: line)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, tol, "max abs diff \(diff)", line: line)
    }

    func testSameChannelsCausal() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("same_channels_causal.safetensors"))
        let conv1 = WrappedConv2d(weight: arrays["conv1.conv.weight"]!, bias: arrays["conv1.conv.bias"]!, kernelSize: 3, padding: 1, causal: true)
        let conv2 = WrappedConv2d(weight: arrays["conv2.conv.weight"]!, bias: arrays["conv2.conv.bias"]!, kernelSize: 3, padding: 1, causal: true)
        let block = AudioResBlock(conv1: conv1, conv2: conv2)
        let actual = block(arrays["input"]!)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }

    func testDifferentChannelsNonCausal() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("diff_channels_noncausal.safetensors"))
        let conv1 = WrappedConv2d(weight: arrays["conv1.conv.weight"]!, bias: arrays["conv1.conv.bias"]!, kernelSize: 3, padding: 1, causal: false)
        let conv2 = WrappedConv2d(weight: arrays["conv2.conv.weight"]!, bias: arrays["conv2.conv.bias"]!, kernelSize: 3, padding: 1, causal: false)
        let ninShortcut = WrappedConv2d(weight: arrays["nin_shortcut.conv.weight"]!, bias: arrays["nin_shortcut.conv.bias"]!, kernelSize: 1, padding: 0, causal: false)
        let block = AudioResBlock(conv1: conv1, conv2: conv2, ninShortcut: ninShortcut)
        let actual = block(arrays["input"]!)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }
}
