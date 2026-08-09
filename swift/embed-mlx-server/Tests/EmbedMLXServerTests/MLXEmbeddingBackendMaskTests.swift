import XCTest
@testable import EmbedMLXServer

final class MLXEmbeddingBackendMaskTests: XCTestCase {
    func testLengthEqualToBatchMaxLengthIsAllTrue() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [4], batchMaxLength: 4)
        XCTAssertEqual(rows, [[true, true, true, true]])
    }

    func testLengthShorterThanBatchMaxLengthHasTruePrefixThenFalseSuffix() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [2], batchMaxLength: 5)
        XCTAssertEqual(rows, [[true, true, false, false, false]])
    }

    func testMultipleRowsAreIndependent() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [2, 4, 4], batchMaxLength: 4)
        XCTAssertEqual(rows, [
            [true, true, false, false],
            [true, true, true, true],
            [true, true, true, true],
        ])
    }

    func testZeroLengthIsAllFalse() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [0], batchMaxLength: 3)
        XCTAssertEqual(rows, [[false, false, false]])
    }

    func testEmptyLengthsProducesEmptyResult() {
        let rows = MLXEmbeddingBackend.maskRows(lengths: [], batchMaxLength: 5)
        XCTAssertTrue(rows.isEmpty)
    }
}
