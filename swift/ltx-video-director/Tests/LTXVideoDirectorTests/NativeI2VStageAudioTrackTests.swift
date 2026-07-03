import XCTest
import MLX
@testable import LTXVideoDirector

/// Real-checkpoint integration tests for custom audio injection
/// (--audio-track) — see NativeI2VStage.Request.audioTrackPath's header and
/// docs/reference/comfyui_workflows/README.md finding 5 ("Custom Audio") for
/// where this is ported from.
///
/// Unlike FFLF's video-frame test (which can pixel-diff a decoded frame
/// directly against the pinned PNG), the audio path's mel+VAE+vocoder
/// roundtrip is lossier and phase-sensitive, so a strict sample-level diff
/// against the injected WAV isn't a reliable signal. Instead this verifies
/// the wiring end-to-end the way it can be verified honestly: same
/// seed/prompt, with vs. without --audio-track, MUST produce different
/// audio output (proving the injected track actually reaches generation
/// rather than being silently ignored).
final class NativeI2VStageAudioTrackTests: XCTestCase {
    private func checkpointsAvailable() -> Bool {
        let fm = FileManager.default
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        let audioVAEURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        return fm.fileExists(atPath: transformerURL.path) && fm.fileExists(atPath: vaeEncoderURL.path) && fm.fileExists(atPath: audioVAEURL.path)
    }

    private func makeToneWAV(frequencyHz: Double, seconds: Double, sampleRate: Int, to url: URL) throws {
        let count = Int(Double(sampleRate) * seconds)
        var samples = [Float](repeating: 0, count: count)
        for i in 0..<count {
            samples[i] = Float(0.8 * sin(2.0 * Double.pi * frequencyHz * Double(i) / Double(sampleRate)))
        }
        try WAVWriter.write(channels: [samples, samples], sampleRate: sampleRate, to: url)
    }

    func testAudioTrackChangesGeneratedAudioVersusBaseline() throws {
        guard checkpointsAvailable() else {
            throw XCTSkip("real checkpoints not found — skipping audio-track integration test")
        }
        let resolved = ResolutionResolver.optimize(width: 320, height: 320)
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_audiotrack_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        // 1 second of a loud 440Hz tone at 44.1kHz — deliberately a common
        // "real world" sample rate different from the encoder's 16kHz, to
        // also exercise LinearResampler in this same test.
        let trackURL = outputDir.appendingPathComponent("track.wav")
        try makeToneWAV(frequencyHz: 440, seconds: 1.0, sampleRate: 44100, to: trackURL)

        let baseRequest = NativeI2VStage.Request(
            prompt: "a woman smiles at the camera", seconds: 17.0 / 24.0,
            width: resolved.width, height: resolved.height, seed: 99, textMaxLength: 8)

        var withTrack = baseRequest
        withTrack.audioTrackPath = trackURL

        let baselineResult = try NativeI2VStage().generate(baseRequest, outputDir: outputDir.appendingPathComponent("baseline"))
        let trackResult = try NativeI2VStage().generate(withTrack, outputDir: outputDir.appendingPathComponent("with_track"))

        let baselineWAV = try WAVReader.read(url: baselineResult.audioURL)
        let trackWAV = try WAVReader.read(url: trackResult.audioURL)

        XCTAssertEqual(baselineWAV.channels.count, trackWAV.channels.count)
        let minLen = min(baselineWAV.channels[0].count, trackWAV.channels[0].count)
        XCTAssertGreaterThan(minLen, 0)

        var sumAbsDiff: Float = 0
        for i in 0..<minLen { sumAbsDiff += abs(baselineWAV.channels[0][i] - trackWAV.channels[0][i]) }
        let meanAbsDiff = sumAbsDiff / Float(minLen)

        XCTAssertTrue(baselineWAV.channels[0].allSatisfy { $0.isFinite })
        XCTAssertTrue(trackWAV.channels[0].allSatisfy { $0.isFinite })
        XCTAssertGreaterThan(meanAbsDiff, 1e-4, "--audio-track should measurably change the generated audio vs. the no-track baseline (mean abs diff \(meanAbsDiff)) — got near-identical output, injection may not be wired")
    }

    func testAudioTrackNotFoundThrowsClearErrorBeforeGeneration() throws {
        let resolved = ResolutionResolver.optimize(width: 320, height: 320)
        var request = NativeI2VStage.Request(
            prompt: "a woman smiles at the camera", seconds: 9.0 / 24.0,
            width: resolved.width, height: resolved.height, textMaxLength: 8)
        request.audioTrackPath = URL(fileURLWithPath: "/tmp/does_not_exist_\(UUID().uuidString).wav")

        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_audiotrack_missing_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }

        let start = Date()
        XCTAssertThrowsError(try NativeI2VStage().generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeI2VStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .audioTrackNotFound = stageError {} else {
                XCTFail("expected .audioTrackNotFound, got \(stageError)")
            }
        }
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.0, "should fail fast, before any expensive generation work")
    }
}
