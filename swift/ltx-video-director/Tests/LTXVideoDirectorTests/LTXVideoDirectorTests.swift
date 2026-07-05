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

    func testModelRegistryTransformerCheckpointURLFindsEachInstalledVariant() {
        // Every installed variant directory has exactly one
        // transformer-*.safetensors (the rest are shared VAE/audio/upscaler
        // assets) — NativeI2VStage.generate relies on this to pick the right
        // file for --transformer dev/distilled/dasiwa.
        for variant in LTXModelRegistry.installedVariants() {
            let url = LTXModelRegistry.transformerCheckpointURL(variant)
            XCTAssertNotNil(url, "expected a transformer-*.safetensors under \(variant.rawValue)/")
            if let url {
                XCTAssertTrue(url.lastPathComponent.hasPrefix("transformer-"))
                XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
            }
        }
    }
}
