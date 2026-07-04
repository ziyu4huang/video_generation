import XCTest
import MLX
@testable import LTXVideoDirector

/// Verifies LoRAWeights.swift / LoRAFusion.swift against
/// scripts/dump_lora_fusion_reference.py, which runs the REAL vendor
/// `apply_loras`/`LTXV_LORA_COMFY_RENAMING_MAP` on the REAL production
/// distilled LoRA (mlx-models/lora/ltx-2.3-distilled/...int8.safetensors)
/// — this package's only real LTX LoRA file (see the dump script's header
/// for the inventory finding). Covers both single-LoRA fusion and
/// multi-LoRA summing (the same file applied twice at different
/// strengths, since no second real style LoRA exists for LTX yet).
final class LoRAFusionTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/lora_fusion")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/lora_fusion")
    }

    private func maxAbsDiff(_ a: MLXArray, _ b: MLXArray) -> Float {
        MLX.abs(a.asType(.float32) - b.asType(.float32)).max().item(Float.self)
    }

    // MARK: LoRAKeyRemap — contract cases mirroring
    // vendor tests/test_lora_renaming_map.py exactly.

    func testKeyRemapStripsPrefixAndRenamesToOut() {
        XCTAssertEqual(
            LoRAKeyRemap.normalize("diffusion_model.transformer_blocks.0.attn1.to_out.0.lora_A.weight"),
            "transformer_blocks.0.attn1.to_out.lora_A.weight")
    }

    func testKeyRemapVideoFeedForward() {
        XCTAssertEqual(
            LoRAKeyRemap.normalize("transformer_blocks.0.ff.net.0.proj.lora_A.weight"),
            "transformer_blocks.0.ff.proj_in.lora_A.weight")
        XCTAssertEqual(
            LoRAKeyRemap.normalize("transformer_blocks.0.ff.net.2.lora_B.weight"),
            "transformer_blocks.0.ff.proj_out.lora_B.weight")
    }

    func testKeyRemapAudioFeedForward() {
        XCTAssertEqual(
            LoRAKeyRemap.normalize("transformer_blocks.0.audio_ff.net.0.proj.lora_A.weight"),
            "transformer_blocks.0.audio_ff.proj_in.lora_A.weight")
        XCTAssertEqual(
            LoRAKeyRemap.normalize("transformer_blocks.0.audio_ff.net.2.lora_B.weight"),
            "transformer_blocks.0.audio_ff.proj_out.lora_B.weight")
    }

    func testKeyRemapTopLevelLinearUnderscoreToNoUnderscore() {
        XCTAssertEqual(
            LoRAKeyRemap.normalize("transformer_blocks.0.linear_1.lora_A.weight"),
            "transformer_blocks.0.linear1.lora_A.weight")
        XCTAssertEqual(
            LoRAKeyRemap.normalize("transformer_blocks.0.linear_2.lora_B.weight"),
            "transformer_blocks.0.linear2.lora_B.weight")
    }

    // MARK: Real-checkpoint fusion parity

    func testSingleAndMultiLoRAFusionMatchesRealVendorReference() throws {
        let loraURL = RepoPaths.mlxModelsRoot.appendingPathComponent(
            "lora/ltx-2.3-distilled/ltx-2.3-22b-distilled-lora-384-1.1.int8.safetensors")
        guard FileManager.default.fileExists(atPath: loraURL.path) else {
            throw XCTSkip("real distilled LoRA not found — skipping fusion parity test")
        }
        let refURL = refsDir.appendingPathComponent("lora_fusion.safetensors")
        guard FileManager.default.fileExists(atPath: refURL.path) else {
            throw XCTSkip("lora_fusion reference not dumped — run scripts/dump_lora_fusion_reference.py")
        }

        let lora = try LoRAWeights.load(url: loraURL)
        let refs = try MLX.loadArrays(url: refURL)
        let scalarsData = try Data(contentsOf: refsDir.appendingPathComponent("scalars.json"))
        let scalars = try JSONSerialization.jsonObject(with: scalarsData) as! [String: Any]
        let keys = scalars["keys"] as! [String]

        XCTAssertEqual(keys.count, 9, "reference key list changed — update this test's expectations")

        for key in keys {
            let base = refs["base__\(key)"]!
            // LoRAWeights.pairs is keyed WITHOUT the trailing ".weight" (it's
            // stripped alongside ".lora_A"/".lora_B" on load) — LoRAFusion.apply
            // does the same strip internally before querying; replicate it here
            // since this test calls LoRAFusion.delta directly, bypassing apply.
            XCTAssertTrue(key.hasSuffix(".weight"))
            let pairKey = String(key.dropLast(".weight".count))

            // Single-source fusion (strength 1.0).
            guard let singleDelta = LoRAFusion.delta(for: pairKey, sources: [(weights: lora, strength: 1.0)]) else {
                XCTFail("no LoRA delta found for key \(pairKey) — key remap or lookup bug")
                continue
            }
            let singleFused = base + singleDelta
            let expectedSingle = refs["fused_single__\(key)"]!
            XCTAssertEqual(singleFused.shape, expectedSingle.shape, "shape mismatch for \(key)")
            XCTAssertLessThan(maxAbsDiff(singleFused, expectedSingle), 1e-3, "single-LoRA fusion mismatch for \(key)")

            // Multi-source fusion: same file applied twice at strengths 1.0/0.6 —
            // exercises the actual summing branch, not just a single lookup.
            let multiDelta = LoRAFusion.delta(for: pairKey, sources: [
                (weights: lora, strength: 1.0), (weights: lora, strength: 0.6),
            ])!
            let multiFused = base + multiDelta
            let expectedMulti = refs["fused_multi__\(key)"]!
            XCTAssertLessThan(maxAbsDiff(multiFused, expectedMulti), 1e-3, "multi-LoRA fusion mismatch for \(key)")

            // Multi-source delta must NOT equal 2x single-source delta (strengths
            // differ, 1.0 + 0.6 != 2.0) — guards against a "always use first
            // source's strength" bug that would otherwise pass the reference
            // check above by coincidence if the two strengths were equal.
            XCTAssertGreaterThan(maxAbsDiff(multiDelta, singleDelta * 2.0), 1e-6, "multi delta suspiciously equals 2x single delta for \(key)")
        }
    }

    // MARK: VBVR reasoning LoRA — same LoRAWeights/LoRAFusion machinery as
    // the distilled structural LoRA above, applied to a DIFFERENT real LoRA
    // family (run.py's `video vbvr` command / `_RELAY_VARIANTS`'
    // "vbvr-licon-*" entries). No Python-dumped vendor reference exists for
    // this file (unlike the distilled LoRA's dedicated dump script), so this
    // is a lighter load-and-fuse regression rather than a numerical parity
    // test — it still catches a real class of bug: silently loading zero
    // deltas (e.g. a key-remap miss for this file's naming) that a real
    // generation run wouldn't necessarily surface as a crash. A genuine
    // end-to-end real-checkpoint generation with this LoRA fused (native-i2v
    // --lora .../vbvr-licon-390k/...int8.safetensors) was separately run and
    // visually inspected this session — 25/25 frames clean, no artifacts —
    // see docs/TODO.md's "VBVR reasoning LoRA" entry.
    func testVBVRLoRALoadsAndProducesNonZeroFusionDelta() throws {
        let loraURL = RepoPaths.mlxModelsRoot.appendingPathComponent(
            "lora/vbvr-licon-390k/Ltx2.3-Licon-VBVR-I2V-390K-R32.int8.safetensors")
        guard FileManager.default.fileExists(atPath: loraURL.path) else {
            throw XCTSkip("real VBVR LoRA not found — skipping VBVR fusion regression test")
        }
        let lora = try LoRAWeights.load(url: loraURL)
        XCTAssertGreaterThan(lora.pairs.count, 0, "VBVR LoRA file loaded but contains no lora_A/lora_B pairs")

        // Same key convention the distilled-LoRA test above already
        // verified LoRAFusion.delta accepts (a real transformer block
        // linear weight, video branch, self-attention output projection).
        var foundNonZeroDelta = false
        for key in lora.pairs.keys.prefix(20) {
            guard let delta = LoRAFusion.delta(for: key, sources: [(weights: lora, strength: 1.0)]) else { continue }
            if MLX.abs(delta).max().item(Float.self) > 0 {
                foundNonZeroDelta = true
                break
            }
        }
        XCTAssertTrue(foundNonZeroDelta, "no VBVR LoRA key produced a non-zero fusion delta among the first 20 pairs — "
            + "likely a key-remap mismatch for this file's naming convention")
    }

    // MARK: Fusion wiring through TransformerCheckpointLoader

    func testBlockWeightsAppliesLoRAWhenSourcesProvided() throws {
        let loraURL = RepoPaths.mlxModelsRoot.appendingPathComponent(
            "lora/ltx-2.3-distilled/ltx-2.3-22b-distilled-lora-384-1.1.int8.safetensors")
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent(
            "transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard FileManager.default.fileExists(atPath: loraURL.path),
              FileManager.default.fileExists(atPath: transformerURL.path) else {
            throw XCTSkip("real checkpoint/LoRA not found — skipping wiring test")
        }
        let lora = try LoRAWeights.load(url: loraURL)
        let rawTransformer = try MLX.loadArrays(url: transformerURL)
        var stripped: [String: MLXArray] = [:]
        for (key, value) in rawTransformer where key.hasPrefix("transformer.") {
            stripped[String(key.dropFirst("transformer.".count))] = value
        }

        let withoutLoRA = TransformerCheckpointLoader.blockWeights(raw: stripped, blockIndex: 0)
        let withLoRA = TransformerCheckpointLoader.blockWeights(
            raw: stripped, blockIndex: 0, loraSources: [(weights: lora, strength: 1.0)])

        let key = "attn1.to_q.weight"
        XCTAssertEqual(withoutLoRA[key]!.shape, withLoRA[key]!.shape)
        XCTAssertGreaterThan(maxAbsDiff(withoutLoRA[key]!, withLoRA[key]!), 1e-6, "LoRA-fused block weight should differ from the unfused base weight")

        // A key with no LoRA coverage in this block (e.g. none — every attn/ff
        // key IS covered by the distilled LoRA) is not asserted here since the
        // distilled LoRA touches every Linear; the shape+difference checks
        // above already confirm the fusion path actually ran.
    }
}
