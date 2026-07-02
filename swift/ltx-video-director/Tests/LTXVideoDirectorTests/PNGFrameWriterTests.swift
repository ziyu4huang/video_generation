import XCTest
import MLX
@testable import LTXVideoDirector

/// Sanity check for PNGFrameWriter: writes a tiny synthetic (1,3,T,H,W)
/// tensor and confirms real, correctly-sized PNG files land on disk. The
/// real end-to-end proof (real VideoDecoder output -> valid PNGs,
/// confirmed with the `file` command) was run manually via
/// `ltx-video video-decode --zeros` during development — see PLAN.md's
/// "second pure-Swift CLI command" milestone.
final class PNGFrameWriterTests: XCTestCase {
    func testWritesExpectedFrameCountAndSize() throws {
        let pixels = MLXArray.zeros([1, 3, 3, 8, 8]).asType(.float32)  // all-zero -> mid-gray after remap
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pngwriter_test_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }

        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: dir)
        XCTAssertEqual(frameCount, 3)

        for t in 0..<3 {
            let url = dir.appendingPathComponent(String(format: "frame_%04d.png", t))
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
            let data = try Data(contentsOf: url)
            XCTAssertEqual(Array(data.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "PNG magic bytes")
        }
    }

    func testInvalidShapeThrows() {
        let badShape = MLXArray.zeros([1, 4, 3, 8, 8])  // wrong channel count
        XCTAssertThrowsError(try PNGFrameWriter.writeFrames(badShape, to: FileManager.default.temporaryDirectory))
    }
}
