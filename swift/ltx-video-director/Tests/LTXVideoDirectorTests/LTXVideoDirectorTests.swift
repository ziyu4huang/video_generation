import XCTest
@testable import LTXVideoDirector

final class LTXVideoDirectorTests: XCTestCase {

    func testFrameCountSnapsToLTXStride() {
        var req = I2VRequest(prompt: "test")
        req.seconds = 10.0
        req.fps = 24.0
        // nearest 8k+1 to 240 is 241 (8*30+1) vs 233 (8*29+1); 241 is closer.
        XCTAssertEqual(req.frames, 241)
        XCTAssertEqual((req.frames - 1) % 8, 0)
    }

    func testFrameCountHandlesShortClips() {
        var req = I2VRequest(prompt: "test")
        req.seconds = 0.3
        req.fps = 24.0
        XCTAssertGreaterThanOrEqual(req.frames, 9)
        XCTAssertEqual((req.frames - 1) % 8, 0)
    }

    func testModelRegistryFindsInstalledLTXVariants() {
        // mlx-models/ltx-mlx/{dev,distilled,dasiwa} are checked into this
        // repo's external model store — at least one variant should be found.
        let installed = LTXModelRegistry.installedVariants()
        XCTAssertFalse(installed.isEmpty)
    }
}
