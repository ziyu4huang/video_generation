//
//  StrengthRescaleTests.swift
//  Krea2ImageDirectorTests
//
//  Deterministic, GPU-free check that the strength-rescaling of the per-frequency
//  K-scale endpoints (nodes.py:1987-1989, Gap 5) is wired and behaves correctly:
//  identity at strength=1.0, collapse to 1 at strength=0, monotonic dampening in
//  between, and the 1.5 cap on the high endpoint. This is the "mechanism is live"
//  proof for the port — no Metal/oracle needed.
//

import XCTest
@testable import Krea2ImageDirector

final class StrengthRescaleTests: XCTestCase {
    // Recommended-preset endpoints (ComfyUI _RECOMMENDED).
    private let highStart: Float = 1.04
    private let lowEnd: Float = 1.10

    func testIdentityAtStrengthOne() {
        // strength=1.0 → endpoints unchanged (no regression to recommended-preset runs).
        let (eh, el) = Krea2Engine.effectiveScaleEndpoints(
            highStart: highStart, lowEnd: lowEnd, strength: 1.0)
        XCTAssertEqual(eh, highStart, accuracy: 1e-6)
        XCTAssertEqual(el, lowEnd, accuracy: 1e-6)
    }

    func testCollapseToOneAtStrengthZero() {
        // strength=0 → both endpoints collapse to 1 (the corruption-gate reduction;
        // the styled path is discarded by mix=0 anyway, so output stays vanilla).
        let (eh, el) = Krea2Engine.effectiveScaleEndpoints(
            highStart: highStart, lowEnd: lowEnd, strength: 0.0)
        XCTAssertEqual(eh, 1.0, accuracy: 1e-6)
        XCTAssertEqual(el, 1.0, accuracy: 1e-6)
    }

    func testMonotonicDampeningHigh() {
        // As strength rises 0→1, the high endpoint rises monotonically 1 → highStart.
        var prev: Float = -1
        for s in stride(from: Float(0.0), through: 1.0, by: 0.1) {
            let (eh, _) = Krea2Engine.effectiveScaleEndpoints(
                highStart: highStart, lowEnd: lowEnd, strength: s)
            XCTAssertGreaterThanOrEqual(eh, prev, "high endpoint must be monotonic in strength")
            prev = eh
        }
        XCTAssertEqual(prev, highStart, accuracy: 1e-6)
    }

    func testHighEndpointCapsAtStrengthOnePointFive() {
        // min(strength, 1.5): the high endpoint stops growing past strength=1.5.
        let (ehAt1_5, _) = Krea2Engine.effectiveScaleEndpoints(
            highStart: highStart, lowEnd: lowEnd, strength: 1.5)
        let (ehAt3, _) = Krea2Engine.effectiveScaleEndpoints(
            highStart: highStart, lowEnd: lowEnd, strength: 3.0)
        XCTAssertEqual(ehAt1_5, ehAt3, accuracy: 1e-6, "high endpoint caps at strength=1.5")
        // At the cap: 1 + (1.04-1)*1.5 = 1.06
        XCTAssertEqual(ehAt1_5, 1.06, accuracy: 1e-6)
    }

    func testLowEndpointMatchesUpstreamFormula() {
        // effective_low = 1 + (low_end-1)·strength (no cap on the low endpoint).
        for s: Float in [0.25, 0.5, 0.75] {
            let (_, el) = Krea2Engine.effectiveScaleEndpoints(
                highStart: highStart, lowEnd: lowEnd, strength: s)
            let expected = 1 + (lowEnd - 1) * s
            XCTAssertEqual(el, expected, accuracy: 1e-6)
        }
    }
}
