//
//  VideoGateTests.swift
//  LTXVideoDirectorTests
//
//  Regression for a real bug found via a live A/B upscale-verification run
//  (s2-agent-ext-ltx TODO): `ltx-video gate --json` reported "could not
//  read/probe video" for a genuinely valid, ffprobe-readable audio-less mp4
//  (native-upscale's own output when run without --refine-audio). The video
//  itself decoded fine — `VideoGate.evaluate` returned a normal verdict.
//  What actually failed was JSON encoding: `meanDBFS` is `-.infinity` for
//  audio-less clips, and `JSONEncoder`'s default strategy throws
//  `EncodingError.invalidValue` on any non-finite Double — silently caught by
//  `GateCommand.swift`'s `try? encoder.encode(...)` and mapped to the wrong
//  error message. Fixed via `nonConformingFloatEncodingStrategy`.
//

import Foundation
import MLX
import XCTest
@testable import LTXVideoDirector

final class VideoGateTests: XCTestCase {
    private func makeFrames(count: Int, width: Int, height: Int, to directory: URL) throws {
        var frames: [MLXArray] = []
        for t in 0..<count {
            let value = Float(t) / Float(max(1, count - 1)) * 2 - 1
            frames.append(MLXArray.full([3, height, width], values: MLXArray(value)))
        }
        let stacked = MLX.stacked(frames, axis: 1).expandedDimensions(axis: 0)
        _ = try PNGFrameWriter.writeFrames(stacked, to: directory)
    }

    func testEvaluateOnAudiolessClipReturnsAVerdictNotNil() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let frameDir = tmp.appendingPathComponent("frames")
        try makeFrames(count: 8, width: 64, height: 48, to: frameDir)
        let outputURL = tmp.appendingPathComponent("out.mp4")
        try MP4Writer.write(frameDirectory: frameDir, audioURL: nil, fps: 8.0, to: outputURL)

        let verdict = try VideoGate.evaluate(videoURL: outputURL, expectVoice: false)
        XCTAssertFalse(verdict.hasAudio)
        XCTAssertEqual(verdict.meanDBFS, -.infinity)
    }

    // The actual regression: JSONEncoder's default strategy throws on a
    // non-finite Double (meanDBFS = -.infinity here), which is exactly what
    // GateCommand.swift's `try? encoder.encode(verdict)` swallowed into a
    // false "could not read/probe video". Assert both that the DEFAULT
    // strategy throws (documents why the bug happened) and that the fixed
    // `.convertToString` strategy encodes successfully (documents the fix).
    func testVerdictWithInfiniteMeanDBFSFailsDefaultJSONEncodingButSucceedsWithConvertToStringStrategy() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let frameDir = tmp.appendingPathComponent("frames")
        try makeFrames(count: 8, width: 64, height: 48, to: frameDir)
        let outputURL = tmp.appendingPathComponent("out.mp4")
        try MP4Writer.write(frameDirectory: frameDir, audioURL: nil, fps: 8.0, to: outputURL)
        let verdict = try VideoGate.evaluate(videoURL: outputURL, expectVoice: false)

        let defaultEncoder = JSONEncoder()
        XCTAssertThrowsError(try defaultEncoder.encode(verdict)) { error in
            XCTAssertTrue("\(error)".contains("invalidValue") || error is EncodingError)
        }

        let fixedEncoder = JSONEncoder()
        fixedEncoder.nonConformingFloatEncodingStrategy = .convertToString(
            positiveInfinity: "inf", negativeInfinity: "-inf", nan: "nan")
        let data = try fixedEncoder.encode(verdict)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["meanDBFS"] as? String, "-inf")
        XCTAssertEqual(obj["hasAudio"] as? Bool, false)
    }
}
