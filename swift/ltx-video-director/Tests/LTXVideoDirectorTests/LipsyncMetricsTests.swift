import XCTest
@testable import LTXVideoDirector

final class LipsyncMetricsTests: XCTestCase {
    func testLinearResampleUpsamples() {
        let result = LipsyncMetrics.linearResample([0.0, 10.0], to: 5)
        XCTAssertEqual(result.count, 5)
        XCTAssertEqual(result.first!, 0.0, accuracy: 1e-9)
        XCTAssertEqual(result.last!, 10.0, accuracy: 1e-9)
        XCTAssertEqual(result[2], 5.0, accuracy: 1e-9)
    }

    func testLinearResampleSinglePoint() {
        let result = LipsyncMetrics.linearResample([7.0], to: 3)
        XCTAssertEqual(result, [7.0, 7.0, 7.0])
    }

    func testLinearResampleEmptySourceReturnsZeros() {
        let result = LipsyncMetrics.linearResample([], to: 4)
        XCTAssertEqual(result, [0.0, 0.0, 0.0, 0.0])
    }

    func testLaggedPearsonPerfectPositiveCorrelationAtLagZero() {
        let a = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        let b = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        let (r, lag) = LipsyncMetrics.laggedPearson(a, b, maxLag: 2)
        XCTAssertEqual(r, 1.0, accuracy: 1e-6)
        XCTAssertEqual(lag, 0)
    }

    func testLaggedPearsonFindsShiftedCorrelation() {
        // b is a shifted onto a by 2 positions — best match at lag=2.
        // Quadratic (non-linear) values, not a plain arithmetic ramp: any
        // two equal-length windows of a *linear* ramp are perfectly
        // correlated regardless of alignment, which would make the "best"
        // lag undefined/tied. Squaring breaks that degeneracy so lag=2 is
        // the unique maximum.
        let a = [1.0, 4.0, 9.0, 16.0, 25.0, 36.0, 49.0, 64.0, 81.0, 100.0]
        let b = [0.0, 0.0, 1.0, 4.0, 9.0, 16.0, 25.0, 36.0, 49.0, 64.0]
        let (r, lag) = LipsyncMetrics.laggedPearson(a, b, maxLag: 4)
        XCTAssertEqual(lag, 2)
        XCTAssertGreaterThan(r, 0.99)
    }

    func testLaggedPearsonTooFewSamplesReturnsZero() {
        let (r, lag) = LipsyncMetrics.laggedPearson([1.0, 2.0], [1.0, 2.0], maxLag: 2)
        XCTAssertEqual(r, 0.0)
        XCTAssertEqual(lag, 0)
    }

    func testLaggedPearsonSkipsNaNPairs() {
        let a = [1.0, 2.0, Double.nan, 4.0, 5.0, 6.0, 7.0, 8.0]
        let b = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        let (r, lag) = LipsyncMetrics.laggedPearson(a, b, maxLag: 1)
        XCTAssertGreaterThan(r, 0.9)
        XCTAssertEqual(lag, 0)
    }
}
