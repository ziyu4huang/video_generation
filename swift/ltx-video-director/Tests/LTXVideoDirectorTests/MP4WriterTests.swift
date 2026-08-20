//
//  MP4WriterTests.swift
//  LTXVideoDirectorTests
//
//  Synthetic end-to-end check: PNG frame sequence (+ optional WAV) -> real
//  .mp4, verified by reading the muxed file back with VideoProbe
//  (AVFoundation) rather than just checking "did it throw" — mirrors this
//  package's established practice of not trusting a write path that never
//  reads its own output back.
//

import Foundation
import MLX
import XCTest
@testable import LTXVideoDirector

final class MP4WriterTests: XCTestCase {
    private func makeFrames(count: Int, width: Int, height: Int, to directory: URL) throws {
        // (1, 3, T, H, W) in [-1, 1] — a simple per-frame solid color ramp.
        var frames: [MLXArray] = []
        for t in 0..<count {
            let value = Float(t) / Float(max(1, count - 1)) * 2 - 1
            frames.append(MLXArray.full([3, height, width], values: MLXArray(value)))
        }
        let stacked = MLX.stacked(frames, axis: 1).expandedDimensions(axis: 0)  // (1, 3, T, H, W)
        _ = try PNGFrameWriter.writeFrames(stacked, to: directory)
    }

    func testWriteVideoOnly() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let frameDir = tmp.appendingPathComponent("frames")
        try makeFrames(count: 8, width: 64, height: 48, to: frameDir)

        let outputURL = tmp.appendingPathComponent("out.mp4")
        try MP4Writer.write(frameDirectory: frameDir, audioURL: nil, fps: 8.0, to: outputURL)

        XCTAssertTrue(FileManager.default.fileExists(atPath: outputURL.path))
        let attrs = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        XCTAssertGreaterThan((attrs[.size] as? Int) ?? 0, 0)

        let info = try VideoProbe.info(url: outputURL)
        XCTAssertEqual(info.width, 64)
        XCTAssertEqual(info.height, 48)
        XCTAssertFalse(info.hasAudioTrack)
        XCTAssertEqual(info.duration, 1.0, accuracy: 0.2)  // 8 frames @ 8fps
    }

    func testWriteVideoWithAudio() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let frameDir = tmp.appendingPathComponent("frames")
        try makeFrames(count: 8, width: 32, height: 32, to: frameDir)

        let sampleRate = 16000
        let toneFrames = sampleRate  // 1 second
        var samples = [Float](repeating: 0, count: toneFrames)
        for i in 0..<toneFrames {
            samples[i] = sin(2.0 * .pi * 440.0 * Float(i) / Float(sampleRate)) * 0.5
        }
        let audioURL = tmp.appendingPathComponent("audio.wav")
        try WAVWriter.write(channels: [samples, samples], sampleRate: sampleRate, to: audioURL)

        let outputURL = tmp.appendingPathComponent("out.mp4")
        try MP4Writer.write(frameDirectory: frameDir, audioURL: audioURL, fps: 8.0, to: outputURL)

        let info = try VideoProbe.info(url: outputURL)
        XCTAssertTrue(info.hasAudioTrack)
        XCTAssertEqual(info.duration, 1.0, accuracy: 0.2)
    }

    /// Regression for a real deadlock found via a live FFLF proof run through
    /// the actual s2-agent `ltx` tool (not a unit test): a genuine
    /// AVAssetWriter multi-track stall, not a slowness issue. `write()` used
    /// to append ALL video frames to completion, with the audio input never
    /// touched until video finished — AVAssetWriter throttles
    /// `isReadyForMoreMediaData` on whichever input runs furthest ahead in
    /// presentation time, to bound its own buffering, and expects the OTHER
    /// input to be actively draining in parallel to relieve that throttle.
    /// The two existing tests above never caught this: 8 frames / 1s is too
    /// small to cross whatever internal threshold triggers the throttle. A
    /// real ~2s/49-frame 640x960 FFLF clip did, hanging indefinitely with
    /// 0% CPU and zero video.mp4 bytes written for 15+ minutes in production.
    /// Fixed by writing both tracks CONCURRENTLY (DispatchGroup, one queue
    /// per track) instead of video-then-audio. This test uses a still-modest
    /// but closer-to-real frame count/resolution/duration and a hard
    /// XCTestExpectation timeout well under the observed real hang, so a
    /// regression FAILS FAST instead of hanging the test suite.
    func testWriteVideoWithAudioAtRealisticScaleDoesNotDeadlock() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let frameDir = tmp.appendingPathComponent("frames")
        // Real production dims trigger real H.264 encoder work per frame
        // (unlike the tiny 32x32/64x48 clips above) — part of what the
        // original 8-frame test missed.
        try makeFrames(count: 49, width: 320, height: 480, to: frameDir)

        let sampleRate = 24000
        let toneFrames = Int(2.04 * Double(sampleRate))  // ~ the 49-frame/24fps clip's own duration
        var samples = [Float](repeating: 0, count: toneFrames)
        for i in 0..<toneFrames {
            samples[i] = sin(2.0 * .pi * 440.0 * Float(i) / Float(sampleRate)) * 0.5
        }
        let audioURL = tmp.appendingPathComponent("audio.wav")
        try WAVWriter.write(channels: [samples, samples], sampleRate: sampleRate, to: audioURL)

        let outputURL = tmp.appendingPathComponent("out.mp4")
        let expectation = expectation(description: "MP4Writer.write completes without deadlocking")
        nonisolated(unsafe) var writeError: Error?
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try MP4Writer.write(frameDirectory: frameDir, audioURL: audioURL, fps: 24.0, to: outputURL)
            } catch {
                writeError = error
            }
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 60)
        if let writeError { XCTFail("MP4Writer.write threw: \(writeError)") }

        let info = try VideoProbe.info(url: outputURL)
        XCTAssertTrue(info.hasAudioTrack)
        XCTAssertEqual(info.width, 320)
        XCTAssertEqual(info.height, 480)
    }

    func testNoFramesThrows() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        XCTAssertThrowsError(try MP4Writer.write(frameDirectory: tmp, audioURL: nil, fps: 24.0, to: tmp.appendingPathComponent("out.mp4")))
    }
}
