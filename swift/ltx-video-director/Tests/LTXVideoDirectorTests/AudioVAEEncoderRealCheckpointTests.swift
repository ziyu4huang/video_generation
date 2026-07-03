import XCTest
import MLX
@testable import LTXVideoDirector

/// Verifies AudioVAEEncoder.swift + AudioVAEEncoderLoader.swift against
/// scripts/dump_audio_vae_encoder_reference.py, which loads the REAL
/// production checkpoint (mlx-models/audio/ltx-2.3-audio/audio_vae.safetensors)
/// into the REAL vendor ltx_core_mlx.model.audio_vae.encoder.AudioVAEEncoder
/// and runs a synthetic mel spectrogram through `.encode()`. Same bar as
/// LoRAFusionTests/NativeI2VStageFFLFTests: diffed against actual vendor
/// output, not just checked for finite/sane shape.
final class AudioVAEEncoderRealCheckpointTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/audio_vae_encoder")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/audio_vae_encoder")
    }

    func testEncodeMatchesRealVendorReference() throws {
        let refURL = refsDir.appendingPathComponent("audio_vae_encoder.safetensors")
        guard FileManager.default.fileExists(atPath: refURL.path) else {
            throw XCTSkip("reference not found at \(refURL.path) — run scripts/dump_audio_vae_encoder_reference.py first")
        }
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real checkpoint not found at \(checkpointURL.path)")
        }

        let ref = try MLX.loadArrays(url: refURL)
        guard let melInput = ref["mel_input"], let expectedLatent = ref["latent_output"] else {
            XCTFail("reference file missing expected keys")
            return
        }

        let encoder = try AudioVAEEncoderLoader.loadReal(checkpointURL: checkpointURL)
        let latent = encoder(melInput.asType(.float32))
        MLX.eval(latent)

        XCTAssertEqual(latent.shape, expectedLatent.shape, "latent output shape mismatch")
        let diff = MLX.abs(latent.asType(.float32) - expectedLatent.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-2, "AudioVAEEncoder diverges from real vendor reference: max abs diff \(diff)")
    }

    func testEncodeDecodeRoundtripPreservesShapeAndIsFinite() throws {
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real checkpoint not found at \(checkpointURL.path)")
        }
        let encoder = try AudioVAEEncoderLoader.loadReal(checkpointURL: checkpointURL)
        let decoder = try AudioVAEDecoderLoader.loadReal(checkpointURL: checkpointURL)

        let mel = MLXArray.zeros([1, 2, 32, 64]).asType(.float32) + 0.01
        let latent = encoder(mel)
        MLX.eval(latent)
        XCTAssertEqual(latent.shape, [1, 8, 8, 16], "encoder should downsample 64 freq bins -> 16, 32 time steps -> 8")

        let reconstructedMel = decoder(latent)
        MLX.eval(reconstructedMel)
        XCTAssertEqual(reconstructedMel.dim(0), 1)
        XCTAssertEqual(reconstructedMel.dim(1), 2, "mel channel count")
        XCTAssertEqual(reconstructedMel.dim(3), 64, "mel frequency bins")
        let flat = reconstructedMel.asArray(Float.self)
        XCTAssertTrue(flat.allSatisfy { $0.isFinite }, "encode->decode roundtrip produced NaN/Inf")
    }
}
