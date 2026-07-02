import XCTest
import MLX
@testable import LTXVideoDirector

/// Isolates MLXFast.RoPE against mx.nn.RoPE on the exact (B, n_heads, L, head_dim)
/// shape Gemma attention uses. Both sliding (base=1e4, scale=1) and global
/// (base=1e6, scale=1/8) configs. See scripts/dump_gemma_rope_reference.py.
final class GemmaRoPEParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/gemma_rope")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/gemma_rope")
    }

    private func diff(_ a: MLXArray, _ b: MLXArray) -> Float {
        MLX.abs(a.asType(.float32) - b.asType(.float32)).max().item(Float.self)
    }

    func testRoPEMatchesReference() throws {
        let ref = try MLX.loadArrays(url: refsDir.appendingPathComponent("ref.safetensors"))
        let x = ref["input"]!
        let hd = 256

        // Sliding: base=1e4, scale=1
        let sliding = MLXFast.RoPE(x, dimensions: hd, traditional: false, base: 10_000, scale: 1.0, offset: 0)
        MLX.eval(sliding)
        let dSliding = diff(sliding, ref["output_sliding"]!)
        XCTAssertLessThan(dSliding, 1e-4, "sliding RoPE diff \(dSliding)")

        // Global: base=1e6, scale=1/8
        let global = MLXFast.RoPE(x, dimensions: hd, traditional: false, base: 1_000_000, scale: 1.0/8.0, offset: 0)
        MLX.eval(global)
        let dGlobal = diff(global, ref["output_global"]!)
        XCTAssertLessThan(dGlobal, 1e-4, "global RoPE diff \(dGlobal)")
    }
}
