//
//  DualRefTests.swift
//  Krea2ImageDirectorTests
//
//  GPU-free check for the dual-ref plain_average fusion weight normalization
//  (Gap 2). The MLX weighted-mean + config construction run in the model (covered
//  by real-silicon runs + the debug-metallib-gated parity tests); this pins the
//  pure normalization logic so the fusion can't silently drift.
//

import XCTest
@testable import Krea2ImageDirector

final class DualRefTests: XCTestCase {
    func testNormalizeWeightsSumsToOne() {
        let a = Krea2DiT.normalizeWeights([0.7, 0.3])
        XCTAssertEqual(a[0], 0.7, accuracy: 1e-6)
        XCTAssertEqual(a[1], 0.3, accuracy: 1e-6)
        let b = Krea2DiT.normalizeWeights([1, 2, 1])
        XCTAssertEqual(b[0], 0.25, accuracy: 1e-6)
        XCTAssertEqual(b[1], 0.5, accuracy: 1e-6)
        XCTAssertEqual(b[2], 0.25, accuracy: 1e-6)
    }

    func testNormalizeWeightsEqualOnZeroSum() {
        // Degenerate (all-zero) input → equal weights.
        let z = Krea2DiT.normalizeWeights([0, 0])
        XCTAssertEqual(z, [0.5, 0.5])
        let z3 = Krea2DiT.normalizeWeights([0, 0, 0])
        XCTAssertEqual(z3, [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0])
    }

    func testNormalizeWeightsSingleRefIsUnity() {
        // refB=1 → weight [1.0] (the byte-identical-to-single-ref gate reduction).
        let s = Krea2DiT.normalizeWeights([1])
        XCTAssertEqual(s, [1.0])
        let s2 = Krea2DiT.normalizeWeights([42]) // any nonzero → normalized to 1
        XCTAssertEqual(s2, [1.0])
    }
}
