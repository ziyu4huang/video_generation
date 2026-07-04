//
//  VideoSceneDetectorTests.swift
//  LTXVideoDirectorTests
//
//  Bit-exact parity for VideoSceneDetector.swift (native port of
//  `run.py video segment`'s scene-cut detection) against the REAL
//  `app.video_utils.detect_scenes`/`scenes_to_timestamps` output on a
//  synthetic fixture (test_refs/video_scene_detect/three_color_scenes.mp4:
//  three solid-color 1s/10fps segments — red, blue, green — concatenated).
//  See scripts/dump_video_scene_detect_reference.py for how the reference
//  was produced, and VideoSceneDetector.swift's header for why a synthetic
//  fixture (not a real generated clip) is the right test material here:
//  scene-cut detection is a deterministic CV algorithm over pixel
//  statistics, not a model-quality question.
//

import Foundation
import XCTest
@testable import LTXVideoDirector

final class VideoSceneDetectorTests: XCTestCase {
    private func refsDir(_ name: String) -> URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/\(name)")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/\(name)")
    }

    func testDetectsSceneCutsMatchingRealOpenCVReference() throws {
        let refDir = refsDir("video_scene_detect")
        let refFile = refDir.appendingPathComponent("video_scene_detect.json")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: refFile.path), "video_scene_detect reference not dumped — run scripts/dump_video_scene_detect_reference.py")
        let videoFile = refDir.appendingPathComponent("three_color_scenes.mp4")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: videoFile.path), "three_color_scenes.mp4 fixture missing")

        let refData = try Data(contentsOf: refFile)
        guard let ref = try JSONSerialization.jsonObject(with: refData) as? [String: Any],
              let fps = ref["fps"] as? Double,
              let expectedScenes = ref["scenes"] as? [[String: Int]] else {
            XCTFail("could not parse video_scene_detect.json"); return
        }

        let scenes = try VideoSceneDetector.detectScenes(url: videoFile, threshold: 0.4, minSceneFrames: 8)

        // Bit-exact: same number of scenes, same frame boundaries as the
        // real cv2-backed detect_scenes() on this fixture's three distinct
        // solid-color segments.
        XCTAssertEqual(scenes.count, expectedScenes.count)
        for (i, scene) in scenes.enumerated() {
            XCTAssertEqual(scene.start, expectedScenes[i]["start"])
            XCTAssertEqual(scene.end, expectedScenes[i]["end"])
        }

        let timestamps = VideoSceneDetector.scenesToTimestamps(scenes, fps: fps)
        guard let expectedTimestamps = ref["timestamps"] as? [[String: Any]] else {
            XCTFail("could not parse timestamps"); return
        }
        XCTAssertEqual(timestamps.count, expectedTimestamps.count)
        for (i, ts) in timestamps.enumerated() {
            let expected = expectedTimestamps[i]
            XCTAssertEqual(ts.sceneNum, expected["scene_num"] as? Int)
            XCTAssertEqual(ts.startFrame, expected["start_frame"] as? Int)
            XCTAssertEqual(ts.endFrame, expected["end_frame"] as? Int)
            XCTAssertEqual(ts.frames, expected["frames"] as? Int)
            XCTAssertEqual(ts.startSec, expected["start_sec"] as? Double ?? -1, accuracy: 1e-6)
            XCTAssertEqual(ts.endSec, expected["end_sec"] as? Double ?? -1, accuracy: 1e-6)
            XCTAssertEqual(ts.durationSec, expected["duration_sec"] as? Double ?? -1, accuracy: 1e-6)
        }
    }

    /// A single continuous shot (no scene changes) must produce exactly one
    /// scene spanning the whole clip — mirrors detect_scenes' "no scenes
    /// detected" fallback in run_segment (video-segment.py).
    func testSingleColorClipProducesOneScene() throws {
        let refDir = refsDir("video_scene_detect")
        let videoFile = refDir.appendingPathComponent("three_color_scenes.mp4")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: videoFile.path), "three_color_scenes.mp4 fixture missing")

        // A very low threshold means almost nothing counts as a "cut" —
        // structurally equivalent to a single-shot clip for this algorithm.
        let scenes = try VideoSceneDetector.detectScenes(url: videoFile, threshold: -1.0, minSceneFrames: 8)
        XCTAssertEqual(scenes.count, 1)
        XCTAssertEqual(scenes[0].start, 0)
        XCTAssertEqual(scenes[0].end, 29)
    }
}
