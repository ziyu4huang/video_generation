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
        let groups = loaded.keyAudit.groupCounts
        XCTAssertEqual(groups["t_embedder"], 8)
        XCTAssertEqual(groups["x_embedder"], 4)
        XCTAssertEqual(groups["cap_embedder"], 5)
        XCTAssertEqual(groups["noise_refiner"], 62, "2 modulated blocks × 31 keys")
        XCTAssertEqual(groups["context_refiner"], 54, "2 non-modulated blocks × 27 keys")
        XCTAssertEqual(groups["layers"], 930, "30 modulated blocks × 31 keys")
        XCTAssertEqual(groups["final_layer"], 8)
        XCTAssertEqual(groups["x_pad_token"], 1)
        XCTAssertEqual(groups["cap_pad_token"], 1)

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

    // MARK: - Model registry (axis 2)

    func testRegistryDiscoversTransformerTypes() {
        let types = ModelRegistry.listTypes()
        XCTAssertTrue(types.contains("transformer"), "expected transformer in types: \(types)")
        XCTAssertTrue(types.contains("lora"), "expected lora in types: \(types)")
        XCTAssertTrue(types.contains("vae"), "expected vae in types: \(types)")
    }

    func testRegistryFindsKnownTransformer() throws {
        let manifest = ModelRegistry.manifest(forType: "transformer", name: "moody-pro-mix")
        // Skipped if the repo models tree isn't present (e.g. fresh checkout).
        guard let manifest else {
            let modelsRoot = ModelPaths.modelsRoot.path
            throw XCTSkip("moody-pro-mix manifest not found under \(modelsRoot)")
        }
        XCTAssertEqual(manifest.name, "moody-pro-mix")
        XCTAssertEqual(manifest.type, "transformer")
        XCTAssertEqual(manifest.arch, "zimage-turbo")
        XCTAssertEqual(manifest.weightFile, "model.safetensors")
        XCTAssertTrue(manifest.pipelines.contains("zimage-turbo"))
        XCTAssertTrue(manifest.compatibleWith.contains("tokenizer/qwen3"))
    }

    func testRegistryFindByArchFiltersZimageOnly() throws {
        let zimageT = ModelRegistry.findByArch("transformer", arch: "zimage-turbo")
        let kleinT = ModelRegistry.findByArch("transformer", arch: "flux2-klein-9b")
        // Both groups are non-empty in the repo; ensure arch filter actually
        // separates them (no klein leaks into zimage and vice versa).
        guard !(zimageT.isEmpty && kleinT.isEmpty) else {
            throw XCTSkip("no transformer manifests present")
        }
        for manifest in zimageT { XCTAssertEqual(manifest.arch, "zimage-turbo") }
        for manifest in kleinT { XCTAssertEqual(manifest.arch, "flux2-klein-9b") }
    }

    func testRegistryManifestForUnknownReturnsNil() {
        XCTAssertNil(ModelRegistry.manifest(forType: "transformer", name: "does-not-exist-xyz"))
    }

    // MARK: - Transformer defaults (axis 4)

    func testResolutionTiersResolvePerPipeline() {
        // zimage tiers
        XCTAssertEqual(Resolution.resolvePreset("model", pipeline: .zimage)?.w, 640)
        XCTAssertEqual(Resolution.resolvePreset("model", pipeline: .zimage)?.h, 960)
        XCTAssertEqual(Resolution.resolvePreset("benchmark", pipeline: .zimage)?.w, 1024)
        XCTAssertEqual(Resolution.resolvePreset("large", pipeline: .zimage)?.w, 1280)
        // lens tiers differ (near-square high-res)
        XCTAssertEqual(Resolution.resolvePreset("model", pipeline: .lens)?.w, 1024)
        XCTAssertEqual(Resolution.resolvePreset("model", pipeline: .lens)?.h, 1024)
        // auto falls back to zimage portrait
        XCTAssertEqual(Resolution.resolvePreset("benchmark", pipeline: .auto)?.w, 1024)
        // explicit WxH still works alongside tiers
        XCTAssertEqual(Resolution.resolvePreset("800x1200", pipeline: .zimage)?.0, 800)
        // unknown returns nil
        XCTAssertNil(Resolution.resolvePreset("nonexistent-tier", pipeline: .zimage))
    }

    func testTransformerDefaultsBuiltInWinsOverManifest() throws {
        // dark-beast-dbzit9: built-in table says cfg=3.0 (A/B tested);
        // manifest says cfg=1.0 (stale). Built-in must win.
        let resolved = TransformerDefaultsRegistry.resolve(forTransformer: "dark-beast-dbzit9")
        guard resolved.cfgScale != nil else {
            throw XCTSkip("dark-beast-dbzit9 not present in this models tree")
        }
        XCTAssertEqual(resolved.cfgScale, 3.0, "built-in A/B-tested cfg must beat stale manifest")
        // steps not in built-in table → falls through to manifest (8)
        XCTAssertEqual(resolved.steps, 8)
    }

    func testTransformerDefaultsUnknownModelIsEmpty() {
        let resolved = TransformerDefaultsRegistry.resolve(forTransformer: "no-such-model-xyz")
        XCTAssertTrue(resolved.isEmpty)
    }
}
