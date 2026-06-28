import XCTest
import MLX
@testable import ZImageDirector

final class ZImageDirectorTests: XCTestCase {

    // MARK: - Config

    func testMoodyProMixConfigDefaults() {
        let cfg = TransformerConfig.moodyProMix
        XCTAssertEqual(cfg.dim, 3840)
        XCTAssertEqual(cfg.nheads, 30)
        XCTAssertEqual(cfg.nLayers, 30)
        XCTAssertEqual(cfg.nRefinerLayers, 2)
        XCTAssertEqual(cfg.inChannels, 16)
        XCTAssertEqual(cfg.axesDims, [32, 48, 48])
        XCTAssertEqual(cfg.ropeTheta, 256.0)
        XCTAssertEqual(cfg.tScale, 1000.0)
        XCTAssertTrue(cfg.qkNorm)
    }

    func testConfigDecodesFromJSON() throws {
        let dir = ModelPaths.transformer("moody-pro-mix")
        let cfg = try TransformerConfig.load(from: dir)
        XCTAssertEqual(cfg.dim, 3840)
        XCTAssertEqual(cfg.nLayers, 30)
        XCTAssertEqual(cfg.nRefinerLayers, 2)
        XCTAssertEqual(cfg.inChannels, 16)
        XCTAssertEqual(cfg.capFeatDim, 2560)
        // n_kv_heads present in JSON but we don't store it (== nheads for Z-Image).
    }

    // MARK: - Key audit (pure logic, no file needed)

    func testKeyAuditClassifiesKnownPrefixes() {
        let keys = [
            "t_embedder.linear1.weight", "x_embedder.weight", "cap_embedder.layers.0.weight",
            "layers.0.attention.to_q.weight", "noise_refiner.0.attention.to_k.weight",
            "context_refiner.0.attention.to_v.weight", "final_layer.linear.weight",
            "x_pad_token", "cap_pad_token",
        ]
        let audit = WeightStore.validate(keys: keys, config: .moodyProMix)
        XCTAssertEqual(audit.totalKeys, 9)
        XCTAssertEqual(audit.matchedKeys, 9)
        XCTAssertTrue(audit.unexpectedPrefixes.isEmpty)
        XCTAssertEqual(audit.groupCounts["layers"], 1)
    }

    func testKeyAuditFlagsUnknownPrefix() {
        let audit = WeightStore.validate(keys: ["unknown_module.weight"], config: .moodyProMix)
        XCTAssertEqual(audit.matchedKeys, 0)
        XCTAssertEqual(audit.unexpectedPrefixes, ["unknown_module"])
        XCTAssertThrowsError(try audit.assertValid())
    }

    // MARK: - Full weight load (needs repo's converted weights)

    /// Integration: loads the actual moody-pro-mix safetensors (~6.5 GB).
    /// Skipped automatically if the weights aren't present (e.g. fresh checkout).
    func testLoadMoodyProMixWeights() throws {
        let file = ModelPaths.transformer("moody-pro-mix")
            .appendingPathComponent("model.safetensors")
        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: file.path),
            "moody-pro-mix weights not found at \(file.path)"
        )

        let loaded = try WeightStore.load(variant: "moody-pro-mix")

        // Structural counts — these are the architectural invariants.
        XCTAssertEqual(loaded.keyAudit.totalKeys, 1073, "expected 1073 keys for moody-pro-mix")
        XCTAssertTrue(loaded.keyAudit.unexpectedPrefixes.isEmpty)

        // Per-group expected counts.
        let g = loaded.keyAudit.groupCounts
        XCTAssertEqual(g["t_embedder"], 8)
        XCTAssertEqual(g["x_embedder"], 4)
        XCTAssertEqual(g["cap_embedder"], 5)
        XCTAssertEqual(g["noise_refiner"], 62, "2 modulated blocks × 31 keys")
        XCTAssertEqual(g["context_refiner"], 54, "2 non-modulated blocks × 27 keys")
        XCTAssertEqual(g["layers"], 930, "30 modulated blocks × 31 keys")
        XCTAssertEqual(g["final_layer"], 8)
        XCTAssertEqual(g["x_pad_token"], 1)
        XCTAssertEqual(g["cap_pad_token"], 1)

        // Spot-check representative quantized-linear shapes (8-bit / group 64).
        XCTAssertEqual(loaded.arrays["layers.0.attention.to_q.weight"]?.shape, [3840, 960])
        XCTAssertEqual(loaded.arrays["layers.0.attention.to_q.scales"]?.shape, [3840, 60])
        XCTAssertEqual(loaded.arrays["layers.0.attention.to_q.weight"]?.dtype, .uint32)
        XCTAssertEqual(loaded.arrays["layers.0.attention.norm_q.weight"]?.shape, [128])
        // 30 heads × head_dim 128 = 3840.
        XCTAssertEqual(loaded.config.dim / loaded.config.nheads, 128)

        // refiner shapes share the same per-key structure as main layers.
        XCTAssertEqual(loaded.arrays["noise_refiner.1.attention.to_q.weight"]?.shape, [3840, 960])
        // context_refiner blocks have no adaLN_modulation (modulation=false).
        XCTAssertNil(loaded.arrays["context_refiner.0.adaLN_modulation.weight"])
        XCTAssertNotNil(loaded.arrays["noise_refiner.0.adaLN_modulation.weight"])

        print("\n" + loaded.keyAudit.summary + "\n")
    }
}
