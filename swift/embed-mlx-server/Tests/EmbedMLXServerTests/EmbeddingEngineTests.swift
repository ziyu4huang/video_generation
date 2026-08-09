import Foundation
import XCTest
@testable import EmbedMLXServer

final class EmbeddingEngineTests: XCTestCase {
    /// Records the size of every micro-batch it's called with, and returns a
    /// fake embedding (just the text length) — no MLX, no model, no GPU.
    // @unchecked Sendable: mutable state below is manually protected by
    // `lock` on every access, which the Swift 6 concurrency checker can't
    // verify on its own — see the `withLock` note in `embedMicroBatch`.
    final class RecordingBackend: EmbeddingBackend, @unchecked Sendable {
        private let lock = NSLock()
        private var _batchSizes: [Int] = []
        var batchSizes: [Int] {
            lock.lock()
            defer { lock.unlock() }
            return _batchSizes
        }

        func embedMicroBatch(_ texts: [String]) async throws -> [[Float]] {
            // NSLock.lock()/unlock() are `noasync` on this toolchain (Swift
            // 6.3.3) to prevent priority inversion — use the synchronous
            // `withLock` closure form instead, which is not itself async.
            lock.withLock {
                _batchSizes.append(texts.count)
            }
            return texts.map { [Float($0.count)] }
        }
    }

    func testSplitsIntoMicroBatchesAndPreservesOrder() async throws {
        let backend = RecordingBackend()
        let engine = EmbeddingEngine(backend: backend, microBatchSize: 3)
        let texts = ["a", "bb", "ccc", "dddd", "eeeee", "f", "gg"]

        let results = try await engine.embed(texts: texts)

        XCTAssertEqual(results.map { $0[0] }, texts.map { Float($0.count) })
        XCTAssertEqual(backend.batchSizes, [3, 3, 1])
    }

    func testEmptyInputProducesNoBackendCalls() async throws {
        let backend = RecordingBackend()
        let engine = EmbeddingEngine(backend: backend, microBatchSize: 4)

        let results = try await engine.embed(texts: [])

        XCTAssertTrue(results.isEmpty)
        XCTAssertTrue(backend.batchSizes.isEmpty)
    }

    func testInputSmallerThanMicroBatchSizeIsOneBatch() async throws {
        let backend = RecordingBackend()
        let engine = EmbeddingEngine(backend: backend, microBatchSize: 32)

        _ = try await engine.embed(texts: ["only one"])

        XCTAssertEqual(backend.batchSizes, [1])
    }

    func testInputExactMultipleOfMicroBatchSizeHasNoTrailingPartialBatch() async throws {
        let backend = RecordingBackend()
        let engine = EmbeddingEngine(backend: backend, microBatchSize: 2)

        _ = try await engine.embed(texts: ["a", "b", "c", "d"])

        XCTAssertEqual(backend.batchSizes, [2, 2])
    }

    func testBackendErrorPropagates() async throws {
        struct Boom: Error {}
        final class ThrowingBackend: EmbeddingBackend {
            func embedMicroBatch(_ texts: [String]) async throws -> [[Float]] {
                throw Boom()
            }
        }
        let engine = EmbeddingEngine(backend: ThrowingBackend(), microBatchSize: 8)

        await XCTAssertThrowsErrorAsync(try await engine.embed(texts: ["x"]))
    }
}

// XCTest doesn't ship an async XCTAssertThrowsError overload; this is the
// standard workaround.
func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected an error to be thrown", file: file, line: line)
    } catch {
        // expected
    }
}
