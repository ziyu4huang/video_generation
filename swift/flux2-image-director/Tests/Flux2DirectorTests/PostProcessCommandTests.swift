import XCTest
import MLX
@testable import Flux2Director
import CommonImageDirector

final class PostProcessCommandTests: XCTestCase {
    func testPostProcessSaveRoundTripPreservesDimensions() throws {
        let h = 48, w = 64
        let image = MLXArray(Array(repeating: Float(0.6), count: 3 * h * w), [1, 3, h, w])
        MLX.eval(image)

        var config = PostProcessConfig()
        config.filmGrain = 0.02
        config.sharpening = 0.1
        let result = PostProcessChain.apply(image, config: config)
        MLX.eval(result)

        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("postprocess-test-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try ImageSave.savePNG(result, to: tmp)

        XCTAssertTrue(FileManager.default.fileExists(atPath: tmp.path))
        let (savedW, savedH) = try Flux2ImageLoad.imageSize(at: tmp)
        XCTAssertEqual(savedW, w)
        XCTAssertEqual(savedH, h)
    }
}
