import XCTest
import MLX
@testable import LTXVideoDirector

/// Verifies AudioProcessor.swift's mel spectrogram DSP against
/// scripts/dump_audio_processor_reference.py, which runs the REAL vendor
/// ltx_core_mlx.model.audio_vae.processor.AudioProcessor on a synthetic
/// two-tone stereo waveform. Pure DSP (no learned weights) — this checks
/// the STFT framing, reflect-padding, and Slaney mel filterbank match
/// exactly, not just structurally.
final class AudioProcessorParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/audio_processor")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/audio_processor")
    }

    func testWaveformToMelMatchesRealVendorReference() throws {
        let refURL = refsDir.appendingPathComponent("audio_processor.safetensors")
        guard FileManager.default.fileExists(atPath: refURL.path) else {
            throw XCTSkip("reference not found at \(refURL.path) — run scripts/dump_audio_processor_reference.py first")
        }
        let ref = try MLX.loadArrays(url: refURL)
        guard let waveform = ref["waveform"], let expectedMel = ref["mel"],
              let refMelBasis = ref["mel_basis"], let refWindow = ref["window"] else {
            XCTFail("reference file missing expected keys")
            return
        }

        let processor = AudioProcessor(sampleRate: 16000, nFFT: 1024, hopLength: 160, nMels: 64)

        // Sanity: the deterministically-computed mel filterbank/window must
        // match the vendor's numpy-built ones before even running the STFT.
        let basisDiff = MLX.abs(processor.melBasis - refMelBasis.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(basisDiff, 1e-4, "mel filterbank diverges from vendor Slaney filterbank")
        let windowDiff = MLX.abs(processor.window - refWindow.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(windowDiff, 1e-5, "Hann window diverges from vendor")

        let mel = processor.waveformToMel(waveform.asType(.float32))
        MLX.eval(mel)

        XCTAssertEqual(mel.shape, expectedMel.shape, "mel output shape mismatch")
        let diff = MLX.abs(mel.asType(.float32) - expectedMel.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-2, "mel spectrogram diverges from real vendor AudioProcessor reference: max abs diff \(diff)")
    }
}
