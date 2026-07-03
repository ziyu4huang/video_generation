import XCTest
import MLX
@testable import LTXVideoDirector

/// Verifies Positions.swift / Patchifiers.swift against
/// scripts/dump_positions_patchify_reference.py. Pure arithmetic — no
/// checkpoint weights — so this is a tight numerical parity test, not a
/// real-checkpoint smoke test.
final class PositionsPatchifyParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/positions_patchify")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/positions_patchify")
    }

    private func maxAbsDiff(_ a: MLXArray, _ b: MLXArray) -> Float {
        MLX.abs(a.asType(.float32) - b.asType(.float32)).max().item(Float.self)
    }

    private func loadScalars() throws -> [String: Any] {
        let data = try Data(contentsOf: refsDir.appendingPathComponent("scalars.json"))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    func testComputeVideoPositionsMatchesReference() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("positions_patchify.safetensors"))
        let expected = arrays["video_positions_f4h3w5"]!
        let actual = Positions.computeVideoPositions(numFrames: 4, height: 3, width: 5, frameRate: 24.0)
        XCTAssertEqual(actual.shape, expected.shape)
        XCTAssertLessThan(maxAbsDiff(actual, expected), 1e-5)
    }

    func testComputeAudioPositionsMatchesReference() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("positions_patchify.safetensors"))
        let expected = arrays["audio_positions_t6"]!
        let actual = Positions.computeAudioPositions(numTokens: 6)
        XCTAssertEqual(actual.shape, expected.shape)
        XCTAssertLessThan(maxAbsDiff(actual, expected), 1e-6)
    }

    func testComputeAudioTokenCountMatchesReference() throws {
        let scalars = try loadScalars()
        let expected = scalars["audio_token_count_41frames_24fps"] as! Int
        XCTAssertEqual(Positions.computeAudioTokenCount(numVideoFrames: 41, frameRate: 24.0), expected)
    }

    func testVideoLatentShapeMatchesReference() throws {
        let scalars = try loadScalars()
        let expected = scalars["video_latent_shape_41x64x96"] as! [Int]
        let actual = VideoLatentShape.compute(numFrames: 41, height: 64, width: 96)
        XCTAssertEqual([actual.f, actual.h, actual.w], expected)
    }

    func testVideoPatchifyRoundTripMatchesReference() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("positions_patchify.safetensors"))
        let scalars = try loadScalars()
        let latent = arrays["video_latent_in"]!
        let expectedTokens = arrays["video_tokens_out"]!
        let expectedDims = scalars["video_dims_out"] as! [Int]

        let (tokens, dims) = VideoLatentPatchifier.patchify(latent)
        XCTAssertEqual([dims.f, dims.h, dims.w], expectedDims)
        XCTAssertEqual(tokens.shape, expectedTokens.shape)
        XCTAssertLessThan(maxAbsDiff(tokens, expectedTokens), 1e-5)

        let roundTrip = VideoLatentPatchifier.unpatchify(tokens, dims: dims)
        XCTAssertEqual(roundTrip.shape, latent.shape)
        XCTAssertLessThan(maxAbsDiff(roundTrip, latent), 1e-5)
    }

    func testAudioPatchifyRoundTripMatchesReference() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("positions_patchify.safetensors"))
        let scalars = try loadScalars()
        let latent = arrays["audio_latent_in"]!
        let expectedTokens = arrays["audio_tokens_out"]!
        let expectedT = scalars["audio_t_out"] as! Int

        let (tokens, t) = AudioPatchifier.patchify(latent)
        XCTAssertEqual(t, expectedT)
        XCTAssertEqual(tokens.shape, expectedTokens.shape)
        XCTAssertLessThan(maxAbsDiff(tokens, expectedTokens), 1e-5)

        let roundTrip = AudioPatchifier.unpatchify(tokens)
        XCTAssertEqual(roundTrip.shape, latent.shape)
        XCTAssertLessThan(maxAbsDiff(roundTrip, latent), 1e-5)
    }
}
