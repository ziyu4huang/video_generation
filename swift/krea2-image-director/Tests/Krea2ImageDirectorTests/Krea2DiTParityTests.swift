//
//  Krea2DiTParityTests.swift
//  Krea2ImageDirectorTests
//
//  Numerical parity vs python app/krea2_transformer.Krea2DiT (full forward) +
//  TextFusionTransformer (isolated), at a SMALL random-weight config
//  (features=128, 1 layer). Verifies the block MATH matches, not the real 12B
//  weights. This is the test that surfaced the GELU precise-vs-tanh discrepancy
//  (python now uses tanh to match the torch ref + Swift geluApproximate).
//  See scripts/dump_dit_reference.py.
//

import XCTest
import MLX
import MLXNN
@testable import Krea2ImageDirector

final class Krea2DiTParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/dit")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/dit")
    }

    /// Small config mirroring scripts/dump_dit_reference.py CFG.
    private func smallConfig() -> Krea2Config {
        Krea2Config(features: 128, tdim: 64, txtdim: 64, heads: 4, kvheads: 2,
                    multiplier: 4, layers: 1, patch: 2, channels: 4, theta: 1e3,
                    txtlayers: 4, txtheads: 4, txtkvheads: 4)
    }

    private func maxDiff(_ a: MLXArray, _ b: MLXArray) -> Float {
        MLX.abs(a.asType(.float32) - b.asType(.float32)).max().item(Float.self)
    }

    /// Load a reference oracle, skipping the test if the file is absent.
    /// Oracles are regenerable via scripts/dump_dit_reference.py and deliberately
    /// not all committed (large binaries); tests skip on a fresh clone rather
    /// than fail.
    private func loadRef(_ name: String) throws -> [String: MLXArray] {
        let url = refsDir.appendingPathComponent(name)
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path),
                          "oracle \(name) missing — regenerate via scripts/dump_dit_reference.py")
        return try MLX.loadArrays(url: url)
    }

    /// Staged parity: pinpoints WHICH stage diverges if testFullDiTForward fails.
    /// Each pre-block stage has its own tolerance (tighter than the end-to-end).
    func testDiagnoseStages() throws {
        let arrays = try loadRef("full_dit.safetensors")
        let dit = Krea2DiT(config: smallConfig(), weights: arrays)
        let cfg = dit.config
        let tH = dit.temb(arrays["t_in"]!, cfg.tdim).reshaped([1, cfg.tdim])
        let tmlpOut = dit.lin(MLXNN.geluApproximate(dit.lin(tH, "tmlp.0")), "tmlp.2")
        MLX.eval(tmlpOut)
        XCTAssertLessThan(maxDiff(tmlpOut, arrays["diag_tH"]!), 1e-4, "temb+tmlp stage")

        let tvec = dit.lin(MLXNN.geluApproximate(tmlpOut), "tproj.1")
        MLX.eval(tvec)
        XCTAssertLessThan(maxDiff(tvec, arrays["diag_tvec"]!), 1e-4, "tproj stage")

        // txtFusion needs the SAME bool mask the forward builds (text slice).
        let txtlen = arrays["context_in"]!.dim(1)
        let tm = arrays["mask_in"]![0..., 0..<txtlen]
        let row = tm.expandedDimensions(axis: 1).expandedDimensions(axis: 2)
        let col = tm.expandedDimensions(axis: 1).expandedDimensions(axis: 3)
        let fused = dit.txtFusion(arrays["context_in"]!, mask: row * col)
        MLX.eval(fused)
        XCTAssertLessThan(maxDiff(fused, arrays["diag_fused"]!), 2e-2, "txtFusion stage")

        let ctx = dit.txtMLP(fused)
        MLX.eval(ctx)
        XCTAssertLessThan(maxDiff(ctx, arrays["diag_ctx"]!), 1e-2, "txtMLP stage")
    }

    func testFullDiTForward() throws {
        let arrays = try loadRef("full_dit.safetensors")
        let dit = Krea2DiT(config: smallConfig(), weights: arrays)
        let actual = dit.callAsFunction(
            img: arrays["img_in"]!, context: arrays["context_in"]!,
            t: arrays["t_in"]!, pos: arrays["pos_in"]!, mask: arrays["mask_in"]!)
        MLX.eval(actual)
        let expected = arrays["out"]!
        XCTAssertEqual(actual.shape, expected.shape, "full DiT output shape")
        let diff = maxDiff(actual, expected)
        // attention + 1 block + softmax: tanh-gelu + manual GQA match to ~5e-2.
        XCTAssertLessThan(diff, 5e-2, "full DiT forward max abs diff \(diff)")
    }

    func testTextFusionTransformer() throws {
        let arrays = try loadRef("txtfusion.safetensors")
        let dit = Krea2DiT(config: smallConfig(), weights: arrays)
        let actual = dit.txtFusion(arrays["x_in"]!, mask: arrays["mask_in"]!)
        MLX.eval(actual)
        let expected = arrays["out"]!
        XCTAssertEqual(actual.shape, expected.shape, "txtfusion output shape")
        let diff = maxDiff(actual, expected)
        XCTAssertLessThan(diff, 5e-2, "txtFusion max abs diff \(diff)")
    }
}
