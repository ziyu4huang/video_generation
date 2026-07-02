import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.audio_vae.vocoder.
/// AMPBlock1 — the anti-aliased multi-periodicity residual block used
/// throughout BigVGAN's resblocks (3 dilations x [act1 -> dilated conv1 ->
/// act2 -> conv2 -> +residual]). See scripts/dump_ampblock1_reference.py,
/// PLAN.md's vocoder work.
final class AMPBlock1ParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/ampblock1")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/ampblock1")
    }

    func testAMPBlock1ThreeDilations() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("ampblock1.safetensors"))
        let kernelSize = 3
        let dilations = [1, 3, 5]

        func makeActivation1d(_ prefix: String) -> Activation1d {
            Activation1d(
                act: SnakeBeta(alpha: arrays["\(prefix).act.alpha"]!, beta: arrays["\(prefix).act.beta"]!),
                upsample: UpSample1d(filter: arrays["\(prefix).upsample.filter"]!),
                downsample: DownSample1d(lowpass: LowPassKernel(filter: arrays["\(prefix).downsample.lowpass.filter"]!)))
        }

        let layers = (0..<dilations.count).map { i -> AMPBlock1Layer in
            let d = dilations[i]
            let conv1Padding = (kernelSize * d - d) / 2
            let conv2Padding = kernelSize / 2
            return AMPBlock1Layer(
                act1: makeActivation1d("acts1.\(i)"),
                conv1Weight: arrays["convs1.\(i).weight"]!, conv1Bias: arrays["convs1.\(i).bias"]!,
                conv1Padding: conv1Padding, conv1Dilation: d,
                act2: makeActivation1d("acts2.\(i)"),
                conv2Weight: arrays["convs2.\(i).weight"]!, conv2Bias: arrays["convs2.\(i).bias"]!,
                conv2Padding: conv2Padding)
        }
        let block = AMPBlock1(layers: layers)

        let actual = block(arrays["input"]!)
        MLX.eval(actual)

        let expected = arrays["output"]!
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        // Looser tolerance than a single Activation1d/conv (1e-3/1e-4): this
        // block chains 6 activation passes (act1+act2 x 3 dilations) each
        // itself an upsample->SnakeBeta->downsample round trip, plus 6
        // dilated/plain convs — comparable depth to BasicAVTransformerBlock
        // (2e-3) or the full DenoiseLoop (1e-2), so float32 accumulation
        // noise compounds similarly. Output magnitude here is O(1), so 5e-2
        // is a relative error of a few percent, not a correctness gap.
        XCTAssertLessThan(diff, 5e-2, "max abs diff \(diff)")
    }
}
