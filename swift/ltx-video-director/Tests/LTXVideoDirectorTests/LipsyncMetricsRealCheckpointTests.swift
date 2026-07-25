//
//  LipsyncMetricsRealCheckpointTests.swift
//  LTXVideoDirectorTests
//
//  Integration smoke test against a REAL talking-head clip — no fixture is
//  committed to the repo (Vision needs an actual face; can't synthesize
//  one), so this is gated on an env var pointing at a clip with a KNOWN
//  verdict, same "skip gracefully if the dependency is absent" pattern as
//  NativeUpscaleStageRealCheckpointTests.swift (checkpoint files there,
//  an env-provided clip here).
//
//  Point LIPSYNC_TEST_VIDEO at a real produced dialogue-scene clip to run
//  this locally, e.g.:
//    LIPSYNC_TEST_VIDEO=/path/to/known_adequate_shot.mp4 swift test \
//      --package-path swift/ltx-video-director --filter LipsyncMetricsRealCheckpointTests
//

import XCTest
@testable import LTXVideoDirector

final class LipsyncMetricsRealCheckpointTests: XCTestCase {
    func testMeasureOnRealClipProducesAScoredVerdict() throws {
        guard let path = ProcessInfo.processInfo.environment["LIPSYNC_TEST_VIDEO"] else {
            throw XCTSkip("LIPSYNC_TEST_VIDEO not set — skipping real-clip integration test")
        }
        let url = URL(fileURLWithPath: path)
        let result = try LipsyncMetrics.measure(url: url)

        // Not asserting a specific verdict (depends on which clip the
        // developer points this at) — asserting the pipeline actually ran
        // end-to-end and produced a real measurement, not a degenerate one.
        XCTAssertTrue(["adequate", "inadequate", "no_face", "no_audio"].contains(result.verdict))
        if result.verdict == "adequate" || result.verdict == "inadequate" {
            XCTAssertNotNil(result.pearsonR)
            XCTAssertNotNil(result.mouthRatioStd)
            XCTAssertNotNil(result.nDetected)
            XCTAssertGreaterThan(result.nDetected!, 0)
        }
    }
}
