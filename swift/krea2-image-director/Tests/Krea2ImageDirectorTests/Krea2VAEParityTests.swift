//
//  Krea2VAEParityTests.swift
//  Krea2ImageDirectorTests
//
//  Numerical parity vs python/mlx-movie-director/app/krea2_vae.py (decode + encode).
//  The Python oracle is itself validated against diffusers AutoencoderKLQwenImage
//  (decode max-diff 0.0166, ENCODE max-diff 3e-4 — see scripts/dump_vae_reference.py).
//  The encode path was previously Swift-only with NO oracle (the i2i gap); this
//  test closes it. See scripts/dump_vae_reference.py.
//

import XCTest
import MLX
@testable import Krea2ImageDirector

final class Krea2VAEParityTests: XCTestCase {
    /// Walk up from this test file to find test_refs/vae.
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/vae")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/vae")
    }

    private var vaeWeightsURL: URL { Krea2Engine.vaeWeights }

    /// Skip gracefully if the staging VAE weights aren't present (CI without weights).
    private func loadVAEOrSkip() throws -> [String: MLXArray] {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: vaeWeightsURL.path),
                          "staging VAE weights missing: \(vaeWeightsURL.path)")
        return try MLX.loadArrays(url: vaeWeightsURL)
    }

    /// Load a VAE oracle, skipping if absent (regenerable via
    /// scripts/dump_vae_reference.py; not committed on fresh clones).
    private func loadRef(_ name: String) throws -> [String: MLXArray] {
        let url = refsDir.appendingPathComponent(name)
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path),
                          "oracle \(name) missing — regenerate via scripts/dump_vae_reference.py")
        return try MLX.loadArrays(url: url)
    }

    func testDecodeParity() throws {
        let w = try loadVAEOrSkip()
        let arrays = try loadRef("decode.safetensors")
        let latent = arrays["latent_in"]!
        let expected = arrays["pixels_out"]!
        let actual = Krea2VAE.decode(latent, w)
        MLX.eval(actual)
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 0.05, "VAE decode max abs diff \(diff)")
    }

    func testEncodeParity() throws {
        let w = try loadVAEOrSkip()
        let arrays = try loadRef("encode.safetensors")
        let image = arrays["image_in"]!
        let expected = arrays["latent_out"]!
        let actual = Krea2VAE.encode(image, w)
        MLX.eval(actual)
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 0.05, "VAE encode max abs diff \(diff)")
    }
}
