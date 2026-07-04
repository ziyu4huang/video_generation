//
//  VideoConcatenatorTests.swift
//  LTXVideoDirectorTests
//
//  Synthetic end-to-end check, same convention as MP4WriterTests: build two
//  real .mp4 files via MP4Writer (not mocked), concatenate them, then read
//  the RESULT back with VideoProbe rather than just checking "did it
//  throw" — this is the same "prove the pinned/composed content actually
//  reached the output" bar this package's other tests already hold to.
//

import Foundation
import MLX
import XCTest
@testable import LTXVideoDirector

final class VideoConcatenatorTests: XCTestCase {
    private func makeSegmentMP4(frameCount: Int, width: Int, height: Int, fps: Double, to url: URL) throws {
        var frames: [MLXArray] = []
        for t in 0..<frameCount {
            let value = Float(t) / Float(max(1, frameCount - 1)) * 2 - 1
            frames.append(MLXArray.full([3, height, width], values: MLXArray(value)))
        }
        let stacked = MLX.stacked(frames, axis: 1).expandedDimensions(axis: 0)
        let frameDir = url.deletingLastPathComponent().appendingPathComponent("\(url.lastPathComponent)_frames")
        _ = try PNGFrameWriter.writeFrames(stacked, to: frameDir)
        try MP4Writer.write(frameDirectory: frameDir, audioURL: nil, fps: fps, to: url)
    }

    func testConcatenatesTwoSegmentsIntoOneLongerVideo() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        let seg1 = tmp.appendingPathComponent("seg1.mp4")
        let seg2 = tmp.appendingPathComponent("seg2.mp4")
        try makeSegmentMP4(frameCount: 8, width: 64, height: 48, fps: 8.0, to: seg1)
        try makeSegmentMP4(frameCount: 8, width: 64, height: 48, fps: 8.0, to: seg2)

        let seg1Info = try VideoProbe.info(url: seg1)
        let seg2Info = try VideoProbe.info(url: seg2)

        let outputURL = tmp.appendingPathComponent("concatenated.mp4")
        try VideoConcatenator.concatenate([seg1, seg2], to: outputURL)

        XCTAssertTrue(FileManager.default.fileExists(atPath: outputURL.path))
        let combinedInfo = try VideoProbe.info(url: outputURL)
        XCTAssertEqual(combinedInfo.width, 64)
        XCTAssertEqual(combinedInfo.height, 48)
        XCTAssertEqual(combinedInfo.duration, seg1Info.duration + seg2Info.duration, accuracy: 0.2,
                       "concatenated duration should be the sum of both segments' durations, not just one")
    }

    func testEmptySegmentListThrowsNoSegments() {
        let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("concat_empty_\(UUID().uuidString).mp4")
        XCTAssertThrowsError(try VideoConcatenator.concatenate([], to: outputURL)) { error in
            guard let concatError = error as? VideoConcatenator.ConcatError else {
                XCTFail("expected ConcatError, got \(error)")
                return
            }
            if case .noSegments = concatError {} else {
                XCTFail("expected .noSegments, got \(concatError)")
            }
        }
    }

    // MARK: replaceAudioTrack (native-relay's --relay-audio overlay)

    func testReplaceAudioTrackAddsRealAudioToVideoOnlyClip() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        let videoURL = tmp.appendingPathComponent("video_only.mp4")
        try makeSegmentMP4(frameCount: 8, width: 64, height: 48, fps: 8.0, to: videoURL)  // 1.0s, no audio

        let audioURL = tmp.appendingPathComponent("overlay.wav")
        let sampleRate = 16000
        let samples = [Float](repeating: 0.1, count: sampleRate * 2)  // 2.0s tone, longer than the video
        try WAVWriter.write(channels: [samples, samples], sampleRate: sampleRate, to: audioURL)

        let outputURL = tmp.appendingPathComponent("overlaid.mp4")
        try VideoConcatenator.replaceAudioTrack(videoURL: videoURL, audioURL: audioURL, to: outputURL)

        XCTAssertTrue(FileManager.default.fileExists(atPath: outputURL.path))
        let info = try VideoProbe.info(url: outputURL)
        XCTAssertTrue(info.hasAudioTrack, "output must have an audio track after replaceAudioTrack")
        // Video-only source was silent/absent audio; overlay is 2s but the
        // video is only 1s — output duration should follow the VIDEO track
        // (audio gets trimmed to match, not the other way around).
        XCTAssertEqual(info.duration, 1.0, accuracy: 0.2)
    }

    func testReplaceAudioTrackMissingAudioThrowsNoAudioTrack() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)

        let videoURL = tmp.appendingPathComponent("video_only.mp4")
        try makeSegmentMP4(frameCount: 8, width: 64, height: 48, fps: 8.0, to: videoURL)
        // Deliberately reuse the video-only mp4 as the "audio" source — it has no audio track.
        let outputURL = tmp.appendingPathComponent("overlaid.mp4")

        XCTAssertThrowsError(try VideoConcatenator.replaceAudioTrack(videoURL: videoURL, audioURL: videoURL, to: outputURL)) { error in
            guard let concatError = error as? VideoConcatenator.ConcatError else {
                XCTFail("expected ConcatError, got \(error)")
                return
            }
            if case .noAudioTrack = concatError {} else {
                XCTFail("expected .noAudioTrack, got \(concatError)")
            }
        }
    }
}
