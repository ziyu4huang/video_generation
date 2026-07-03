//
//  RoPEParityTests.swift
//  Krea2ImageDirectorTests
//
//  Numerical parity vs python app/krea2_transformer.PositionalEncoding +
//  _rope_apply at the REAL Krea config (axes [32,48,48], theta=1e3, interleaved
//  2x2 matrix convention). theta=1e3 (not 1e4) and the interleaved-2x2 layout
//  are the easy-to-get-wrong pieces. See scripts/dump_rope_reference.py.
//

import XCTest
import MLX
@testable import Krea2ImageDirector

final class RoPEParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/rope")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/rope")
    }

    /// Empty weights: ropeFreqs/ropeApply read no weights, only config + inputs.
    private func makeDiT() -> Krea2DiT { Krea2DiT(config: Krea2Config(), weights: [:]) }

    private func maxDiff(_ a: MLXArray, _ b: MLXArray) -> Float {
        MLX.abs(a.asType(.float32) - b.asType(.float32)).max().item(Float.self)
    }

    /// Load the RoPE oracle, skipping if absent (regenerable via
    /// scripts/dump_rope_reference.py; not committed on fresh clones).
    private func loadRef() throws -> [String: MLXArray] {
        let url = refsDir.appendingPathComponent("rope.safetensors")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path),
                          "rope.safetensors missing — regenerate via scripts/dump_rope_reference.py")
        return try MLX.loadArrays(url: url)
    }

    func testRopeFreqs() throws {
        let arrays = try loadRef()
        let pos = arrays["pos"]!
        let expected = arrays["freqs"]!
        let dit = makeDiT()
        let actual = dit.ropeFreqs(pos)
        MLX.eval(actual)
        XCTAssertEqual(actual.shape, expected.shape)
        XCTAssertLessThan(maxDiff(actual, expected), 1e-5, "ropeFreqs max abs diff")
    }

    func testRopeApplyQ() throws {
        let arrays = try loadRef()
        let dit = makeDiT()
        let freqs = dit.ropeFreqs(arrays["pos"]!)
        let actual = dit.ropeApply(arrays["xq_in"]!, freqs)   // (1,2,4,128)
        MLX.eval(actual)
        let expected = arrays["xq_out"]!
        XCTAssertEqual(actual.shape, expected.shape)
        XCTAssertLessThan(maxDiff(actual, expected), 1e-4, "ropeApply q max abs diff")
    }

    func testRopeApplyK() throws {
        let arrays = try loadRef()
        let dit = makeDiT()
        let freqs = dit.ropeFreqs(arrays["pos"]!)
        let actual = dit.ropeApply(arrays["xk_in"]!, freqs)   // (1,1,4,128) GQA kv head
        MLX.eval(actual)
        let expected = arrays["xk_out"]!
        XCTAssertEqual(actual.shape, expected.shape)
        XCTAssertLessThan(maxDiff(actual, expected), 1e-4, "ropeApply k max abs diff")
    }
}
