//
//  MacTTSTests.swift
//  LTXVideoDirectorTests
//
//  Real (not mocked) invocation of macOS's `say` — fast and fully local
//  (no network), so no reason to mock it. Confirms the produced AIFF is
//  both a real, non-empty audio file AND decodable by AVFoundation (the
//  same read path VideoConcatenator.replaceAudioTrack uses), not just
//  "say exited 0."
//

import AVFoundation
import Foundation
import XCTest
@testable import LTXVideoDirector

final class MacTTSTests: XCTestCase {
    func testSynthesizeProducesReadableAudio() throws {
        let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("mac_tts_\(UUID().uuidString).aiff")
        defer { try? FileManager.default.removeItem(at: outputURL) }

        try MacTTS.synthesize(text: "測試", to: outputURL)

        XCTAssertTrue(FileManager.default.fileExists(atPath: outputURL.path))
        let attrs = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        XCTAssertGreaterThan((attrs[.size] as? Int) ?? 0, 0)

        let asset = AVURLAsset(url: outputURL)
        let audioTracks = asset.tracks(withMediaType: .audio)
        XCTAssertFalse(audioTracks.isEmpty, "synthesized AIFF must have a readable audio track")
        XCTAssertGreaterThan(CMTimeGetSeconds(asset.duration), 0)
    }

    /// Note: `say -v <unknown voice>` silently falls back to the default
    /// voice (exit 0) rather than failing — confirmed manually, not
    /// assumed. An unwritable output path is the real failure mode `say`
    /// exits non-zero for.
    func testUnwritableOutputPathThrowsNamedError() {
        let outputURL = URL(fileURLWithPath: "/nonexistent_dir_xyz_\(UUID().uuidString)/test.aiff")
        XCTAssertThrowsError(try MacTTS.synthesize(text: "test", to: outputURL)) { error in
            guard let ttsError = error as? MacTTS.TTSError else {
                XCTFail("expected TTSError, got \(error)")
                return
            }
            if case .sayFailed = ttsError {} else {
                XCTFail("expected .sayFailed, got \(ttsError)")
            }
        }
    }
}
