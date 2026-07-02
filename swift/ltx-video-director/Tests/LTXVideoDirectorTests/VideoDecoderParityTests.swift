import XCTest
import MLX
@testable import LTXVideoDirector

/// End-to-end parity check of the FULL VideoDecoder assembly against a
/// MINIATURE decoder built from the REAL ltx_core_mlx components
/// (Conv3dBlock, ResBlockStage, DepthToSpaceUpsample, PerChannelStatistics,
/// pixel_norm, unpatchify_spatial) with the exact same stage/upsample-
/// factor/frame-drop wiring as the real VideoDecoder.decode() — just at
/// tiny channel widths so the reference file stays small (a full-size
/// dump was ~1GB). See scripts/dump_videodecoder_reference.py, PLAN.md
/// Phase 1. Real production weights are verified separately (no stored
/// reference needed) by VideoDecoderRealCheckpointTests.swift.
///
/// This is the first test that verifies the ASSEMBLY logic (residual/
/// upsample interleaving, frame-drop after temporal upsample, final
/// pixelnorm+silu before conv_out, unpatchify, BCFHW<->BFHWC transposes),
/// not just individual ops.
final class VideoDecoderParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/video_decoder")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/video_decoder")
    }

    func testTinyLatentDecode() throws {
        var arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("decode_tiny.safetensors"))
        guard let latent = arrays.removeValue(forKey: "latent"),
              let expected = arrays.removeValue(forKey: "output") else {
            XCTFail("missing latent/output tensors")
            return
        }
        // Remap the dump's flat `res_stages.{i}.*` / `upsamples.{i}.*` keys to
        // VideoDecoder's expected `up_blocks.{idx}.*` checkpoint-shaped keys
        // (idx 0,2,4,6,8 for res stages; 1,3,5,7 for upsamples) — exercises
        // the SAME key-parsing logic VideoDecoderRealCheckpointTests uses
        // against the real checkpoint, not a different loader.
        let resStageIndices = [0, 2, 4, 6, 8]
        let upsampleIndices = [1, 3, 5, 7]
        var weights: [String: MLXArray] = [:]
        for (key, value) in arrays {
            if key.hasPrefix("res_stages.") {
                let rest = key.dropFirst("res_stages.".count)
                let parts = rest.split(separator: ".", maxSplits: 1)
                let i = Int(parts[0])!
                weights["up_blocks.\(resStageIndices[i]).\(parts[1])"] = value
            } else if key.hasPrefix("upsamples.") {
                let rest = key.dropFirst("upsamples.".count)
                let parts = rest.split(separator: ".", maxSplits: 1)
                let i = Int(parts[0])!
                weights["up_blocks.\(upsampleIndices[i]).\(parts[1])"] = value
            } else {
                weights[key] = value
            }
        }

        let decoder = VideoDecoder(weights: weights, causal: false, spatialPaddingMode: "zeros", patchSize: 2)
        let actual = decoder(latent)
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape, "shape mismatch — e.g. F=2 latent should decode to F=9 pixels (2 temporal upsamples with frame-drop, then one tf=1 stage)")
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32))
        let maxDiff = diff.max().item(Float.self)
        XCTAssertLessThan(maxDiff, 1e-3, "max abs diff \(maxDiff) exceeds tolerance (looser than atomic-op tests: 9 stages of fp32 accumulation)")
    }
}
