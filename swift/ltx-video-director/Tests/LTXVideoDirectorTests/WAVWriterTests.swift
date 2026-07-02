import XCTest
@testable import LTXVideoDirector

/// Sanity check for WAVWriter's hand-rolled RIFF/WAVE header: writes a
/// tiny stereo buffer and re-parses the header fields itself (avoiding a
/// dependency on AVFoundation/ffprobe in the test) to confirm sample
/// rate, channel count, and data size round-trip correctly. The actual
/// end-to-end proof (real ffprobe validation of a real decoder+vocoder
/// forward pass) was run manually via `ltx-video audio-decode --zeros`
/// during development — see PLAN.md's "first pure-Swift CLI command"
/// milestone.
final class WAVWriterTests: XCTestCase {
    func testHeaderRoundTrips() throws {
        let left: [Float] = [0.0, 0.5, -0.5, 1.0, -1.0]
        let right: [Float] = [0.0, -0.5, 0.5, -1.0, 1.0]
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("wavwriter_test_\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }

        try WAVWriter.write(channels: [left, right], sampleRate: 48000, to: url)

        let data = try Data(contentsOf: url)
        XCTAssertEqual(String(data: data[0..<4], encoding: .ascii), "RIFF")
        XCTAssertEqual(String(data: data[8..<12], encoding: .ascii), "WAVE")
        XCTAssertEqual(String(data: data[12..<16], encoding: .ascii), "fmt ")

        let numChannels = data[22...23].withUnsafeBytes { $0.load(as: UInt16.self) }
        let sampleRate = data[24...27].withUnsafeBytes { $0.load(as: UInt32.self) }
        let bitsPerSample = data[34...35].withUnsafeBytes { $0.load(as: UInt16.self) }
        XCTAssertEqual(numChannels, 2)
        XCTAssertEqual(sampleRate, 48000)
        XCTAssertEqual(bitsPerSample, 16)

        let dataSize = data[40...43].withUnsafeBytes { $0.load(as: UInt32.self) }
        XCTAssertEqual(Int(dataSize), left.count * 2 /* channels */ * 2 /* bytes/sample */)
        XCTAssertEqual(data.count, 44 + Int(dataSize))
    }

    func testEmptySamplesThrows() {
        XCTAssertThrowsError(try WAVWriter.write(channels: [[]], sampleRate: 48000, to: FileManager.default.temporaryDirectory.appendingPathComponent("unused.wav")))
    }
}
