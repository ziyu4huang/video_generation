import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against the SAME ltx_core_mlx.Conv3dBlock this
/// project's Python MLX pipeline runs (see scripts/dump_conv3d_reference.py,
/// PLAN.md Phase 1). Not a reimplementation comparison — ground truth.
final class Conv3dBlockParityTests: XCTestCase {
    private var refsDir: URL {
        // Tests run from the package root's .build dir; walk up to find test_refs/.
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/conv3d")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/conv3d")
    }

    private func loadCase(_ name: String, causal: Bool, kernel: Int, spatialPaddingMode: String) throws -> (MLXArray, MLXArray) {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("\(name).safetensors"))
        guard let weight = arrays["weight"], let bias = arrays["bias"],
              let input = arrays["input"], let expected = arrays["output"] else {
            XCTFail("missing tensors in \(name).safetensors")
            return (MLXArray.zeros([1]), MLXArray.zeros([1]))
        }
        let block = Conv3dBlock(
            weight: weight, bias: bias, kernelSize: (kernel, kernel, kernel),
            padding: (kernel / 2, kernel / 2, kernel / 2),
            causal: causal, spatialPaddingMode: spatialPaddingMode
        )
        let actual = block(input)
        MLX.eval(actual)
        return (actual, expected)
    }

    private func assertClose(_ actual: MLXArray, _ expected: MLXArray, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.shape, expected.shape, file: file, line: line)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32))
        let maxDiff = diff.max().item(Float.self)
        XCTAssertLessThan(maxDiff, 1e-4, "max abs diff \(maxDiff) exceeds tolerance", file: file, line: line)
    }

    func testCausalZerosPadding() throws {
        let (actual, expected) = try loadCase("causal_zeros", causal: true, kernel: 3, spatialPaddingMode: "zeros")
        assertClose(actual, expected)
    }

    func testNonCausalReflectPadding() throws {
        let (actual, expected) = try loadCase("noncausal_reflect", causal: false, kernel: 3, spatialPaddingMode: "reflect")
        assertClose(actual, expected)
    }

    func testCausalKernelSize1() throws {
        let (actual, expected) = try loadCase("causal_kernel1", causal: true, kernel: 1, spatialPaddingMode: "zeros")
        assertClose(actual, expected)
    }
}
