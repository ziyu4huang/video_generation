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

    func testLinearResampleDownsamples() {
        // The common case at Task 3's real call site: extractAudioEnvelope
        // resamples a much larger RMS-window series down onto a smaller
        // per-video-frame count.
        let result = LipsyncMetrics.linearResample([0.0, 2.0, 4.0, 6.0, 8.0, 10.0], to: 3)
        XCTAssertEqual(result.count, 3)
        XCTAssertEqual(result.first!, 0.0, accuracy: 1e-9)
        XCTAssertEqual(result.last!, 10.0, accuracy: 1e-9)
        XCTAssertEqual(result[1], 5.0, accuracy: 1e-9)
    }

    func testLaggedPearsonPerfectPositiveCorrelationAtLagZero() {
        // Quadratic (non-linear), not a plain arithmetic ramp: any two
        // equal-length windows of a *linear* ramp are perfectly correlated
        // regardless of alignment, which would tie every lag at r == 1.0 and
        // make the "best" lag ambiguous (Python's ascending -maxLag...maxLag
        // search picks the first-seen, most-negative tied lag — not 0).
        // Squaring breaks that degeneracy so lag == 0 is the unique maximum.
        let a = [1.0, 4.0, 9.0, 16.0, 25.0, 36.0, 49.0, 64.0]
        let b = [1.0, 4.0, 9.0, 16.0, 25.0, 36.0, 49.0, 64.0]
        let (r, lag) = LipsyncMetrics.laggedPearson(a, b, maxLag: 2)
        XCTAssertEqual(r, 1.0, accuracy: 1e-6)
        XCTAssertEqual(lag, 0)
    }

    func testLaggedPearsonFindsShiftedCorrelation() {
        // `leading` is the "cause" series; `delayed` is `leading` shifted
        // 2 positions later in time (delayed[i] == leading[i - 2], zero
        // before that) — the same shape as production's `audio_env`
        // (cause) vs. `ratios` (response). Quadratic (non-linear) values,
        // not a plain arithmetic ramp: any two equal-length windows of a
        // *linear* ramp are perfectly correlated regardless of alignment,
        // which would make the "best" lag undefined/tied. Squaring breaks
        // that degeneracy so lag=2 is the unique maximum.
        //
        // Called as laggedPearson(delayed, leading) — response first, cause
        // second — mirroring production's `_lagged_pearson(ratios,
        // audio_env, ...)` call. Positive lag then means "the first argument
        // lags the second by this many samples", so the response being 2
        // samples behind the cause reports lag == 2.
        let leading = [1.0, 4.0, 9.0, 16.0, 25.0, 36.0, 49.0, 64.0, 81.0, 100.0]
        let delayed = [0.0, 0.0, 1.0, 4.0, 9.0, 16.0, 25.0, 36.0, 49.0, 64.0]
        let (r, lag) = LipsyncMetrics.laggedPearson(delayed, leading, maxLag: 4)
        XCTAssertEqual(lag, 2)
        XCTAssertGreaterThan(r, 0.99)
    }

    func testLaggedPearsonTooFewSamplesReturnsZero() {
        let (r, lag) = LipsyncMetrics.laggedPearson([1.0, 2.0], [1.0, 2.0], maxLag: 2)
        XCTAssertEqual(r, 0.0)
        XCTAssertEqual(lag, 0)
    }

    func testLaggedPearsonSkipsNaNPairs() {
        // Quadratic (non-linear), not a plain arithmetic ramp: with a linear
        // ramp, dropping one NaN pair still leaves perfectly-linear
        // sub-windows at every lag, which can round to an exact r == 1.0 tie
        // between lag 0 and neighboring lags — masking whether NaN-dropping
        // itself works. Squaring makes lag 0's r uniquely highest.
        let a = [1.0, 4.0, Double.nan, 16.0, 25.0, 36.0, 49.0, 64.0]
        let b = [1.0, 4.0, 9.0, 16.0, 25.0, 36.0, 49.0, 64.0]
        let (r, lag) = LipsyncMetrics.laggedPearson(a, b, maxLag: 1)
        XCTAssertGreaterThan(r, 0.9)
        XCTAssertEqual(lag, 0)
    }

    func testPearsonReturnsNilForZeroVarianceSeries() {
        let a = [3.0, 3.0, 3.0, 3.0, 3.0]
        let b = [1.0, 2.0, 3.0, 4.0, 5.0]
        XCTAssertNil(LipsyncMetrics.pearson(a, b))
    }

    func testPearsonReturnsNilWithFewerThanFourValidPairs() {
        // 5 samples, but 2 are NaN in `a` — only 3 valid pairs remain, below
        // pearson's minimum of 4.
        let a = [1.0, Double.nan, 3.0, Double.nan, 5.0]
        let b = [1.0, 2.0, 3.0, 4.0, 5.0]
        XCTAssertNil(LipsyncMetrics.pearson(a, b))
    }

    func testClassifyVerdictAdequate() {
        let v = LipsyncMetrics.classifyVerdict(r: 0.55, lag: 0, maxLag: 4, lag0R: 0.5, mouthRatioStd: 0.03)
        XCTAssertEqual(v.verdict, "adequate")
        XCTAssertNil(v.caveat)
    }

    func testClassifyVerdictBelowThresholdIsInadequate() {
        let v = LipsyncMetrics.classifyVerdict(r: 0.2, lag: 0, maxLag: 4, lag0R: 0.2, mouthRatioStd: 0.03)
        XCTAssertEqual(v.verdict, "inadequate")
        XCTAssertNil(v.caveat)
    }

    func testClassifyVerdictFlatMouthSpuriousRTreatedInadequateWithCaveat() {
        let v = LipsyncMetrics.classifyVerdict(r: 0.4, lag: 0, maxLag: 4, lag0R: 0.4, mouthRatioStd: 0.004)
        XCTAssertEqual(v.verdict, "inadequate")
        XCTAssertNotNil(v.caveat)
        XCTAssertTrue(v.caveat!.contains("barely moves"))
    }

    func testClassifyVerdictStronglyNegativeRIsInadequateWithCaveat() {
        let v = LipsyncMetrics.classifyVerdict(r: -0.45, lag: 0, maxLag: 4, lag0R: -0.4, mouthRatioStd: 0.03)
        XCTAssertEqual(v.verdict, "inadequate")
        XCTAssertNotNil(v.caveat)
        XCTAssertTrue(v.caveat!.contains("anti-correlated"))
    }

    func testClassifyVerdictLagBoundaryCaveatOverridesOthers() {
        let v = LipsyncMetrics.classifyVerdict(r: 0.5, lag: 4, maxLag: 4, lag0R: 0.1, mouthRatioStd: 0.03)
        XCTAssertEqual(v.verdict, "adequate")
        XCTAssertNotNil(v.caveat)
        XCTAssertTrue(v.caveat!.contains("search boundary"))
    }

    func testClassifyVerdictLagBoundaryCaveatActuallyOverwritesFlatMouthCaveat() {
        // Unlike testClassifyVerdictLagBoundaryCaveatOverridesOthers above,
        // these inputs *do* trigger the flat-mouth-spurious caveat branch
        // first (mouthRatioStd well below minMouthStdThreshold, with r high
        // enough to have cleared adequateRThreshold) — so this actually
        // proves the lag-boundary `if` (not `else if`) overwrites a caveat
        // that was genuinely set, not just the only one that could fire.
        let v = LipsyncMetrics.classifyVerdict(r: 0.5, lag: 4, maxLag: 4, lag0R: 0.1, mouthRatioStd: 0.005)
        // flatMouth is true, so verdict is "inadequate" regardless of which
        // caveat text wins — only the caveat string is under test here.
        XCTAssertEqual(v.verdict, "inadequate")
        XCTAssertNotNil(v.caveat)
        XCTAssertTrue(v.caveat!.contains("search boundary"))
        XCTAssertFalse(v.caveat!.contains("barely moves"))
    }

    func testClassifyVerdictAtExactThresholdIsAdequate() {
        // r == adequateRThreshold exactly: the comparison in classifyVerdict
        // is `r >= adequateRThreshold`, so the boundary value itself must
        // count as adequate (not the first value past it).
        let v = LipsyncMetrics.classifyVerdict(
            r: LipsyncMetrics.adequateRThreshold, lag: 0, maxLag: 4, lag0R: 0.3, mouthRatioStd: 0.03)
        XCTAssertEqual(v.verdict, "adequate")
        XCTAssertNil(v.caveat)
    }

    func testLipsyncResultCodableRoundTripUsesDocumentedSnakeCaseWireKeys() throws {
        // This is the actual contract bun-apps/s2-agent-ext-movie-director/
        // src/lipsync_metrics.ts parses — lock down the
        // snake_case JSON keys, not Swift's camelCase property names.
        let result = LipsyncMetrics.LipsyncResult(
            verdict: "adequate",
            pearsonR: 0.55,
            mouthRatioStd: 0.03,
            caveat: nil,
            note: nil,
            bestLagFrames: 1,
            lag0PearsonR: 0.5,
            fps: 24.0,
            nFrames: 60,
            nDetected: 58,
            mouthRatioMean: 0.12,
            audioRmsMean: 0.001234
        )
        let data = try JSONEncoder().encode(result)
        let json = String(data: data, encoding: .utf8)!

        XCTAssertTrue(json.contains("\"pearson_r\""))
        XCTAssertFalse(json.contains("\"pearsonR\""))
        XCTAssertTrue(json.contains("\"mouth_ratio_std\""))
        XCTAssertTrue(json.contains("\"best_lag_frames\""))
        XCTAssertTrue(json.contains("\"lag0_pearson_r\""))
        XCTAssertTrue(json.contains("\"n_frames\""))
        XCTAssertTrue(json.contains("\"n_detected\""))
        XCTAssertTrue(json.contains("\"mouth_ratio_mean\""))
        XCTAssertTrue(json.contains("\"audio_rms_mean\""))

        let decoded = try JSONDecoder().decode(LipsyncMetrics.LipsyncResult.self, from: data)
        XCTAssertEqual(decoded.verdict, "adequate")
        XCTAssertEqual(decoded.pearsonR, 0.55)
        XCTAssertEqual(decoded.bestLagFrames, 1)
        XCTAssertEqual(decoded.nDetected, 58)
        XCTAssertEqual(decoded.audioRmsMean, 0.001234)
    }

    func testExtractAudioEnvelopeOnNonexistentFileReturnsZerosWithoutCrashing() {
        // Exercises extractAudioEnvelope's "no usable audio" early return
        // without a real video fixture: AVURLAsset on a nonexistent path
        // synchronously reports zero tracks (rather than throwing/crashing),
        // so decodeMonoPCM's guard fails and this takes the same
        // fewer-than-1024-samples early-return path a silent/missing-track
        // clip would.
        let url = URL(fileURLWithPath: NSTemporaryDirectory() + "lipsync-nonexistent-\(UUID().uuidString).mp4")
        let result = LipsyncMetrics.extractAudioEnvelope(url: url, nSamples: 5)
        XCTAssertEqual(result, [0.0, 0.0, 0.0, 0.0, 0.0])
    }

    func testMeasureOnNonexistentFileThrowsRatherThanCrashing() {
        // Confirms measure(url:)'s documented throws-vs-Python divergence:
        // a genuinely unreadable file surfaces as a thrown VideoProbeError,
        // not a synthesized verdict. No real video fixture needed — a
        // nonexistent path is itself an unreadable file.
        let url = URL(fileURLWithPath: NSTemporaryDirectory() + "lipsync-nonexistent-\(UUID().uuidString).mp4")
        XCTAssertThrowsError(try LipsyncMetrics.measure(url: url)) { error in
            XCTAssertTrue(error is VideoProbeError)
        }
    }
}
