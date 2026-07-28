//
//  DelayPatternTests.swift
//  MusicGenDirectorTests
//
//  Verifies DelayPattern against the exact worked example in HF's
//  modeling_musicgen.py build_delay_pattern_mask docstring (num_codebooks=4,
//  max_length=8):
//    [P, -1, -1, -1, -1, P, P, P]
//    [P, P, -1, -1, -1, -1, P, P]
//    [P, P, P, -1, -1, -1, -1, P]
//    [P, P, P, P, -1, -1, -1, -1]
//

import XCTest
@testable import MusicGenDirector

final class DelayPatternTests: XCTestCase {
    func testBuildMaskMatchesHFDocstringExample() {
        let mask = DelayPattern.buildMask(numCodebooks: 4, maxLength: 8)
        let p = DelayPattern.padTokenId
        XCTAssertEqual(mask[0], [p, -1, -1, -1, -1, p, p, p])
        XCTAssertEqual(mask[1], [p, p, -1, -1, -1, -1, p, p])
        XCTAssertEqual(mask[2], [p, p, p, -1, -1, -1, -1, p])
        XCTAssertEqual(mask[3], [p, p, p, p, -1, -1, -1, -1])
    }

    func testApplyOverwritesOnlyForcedPositions() {
        let mask = DelayPattern.buildMask(numCodebooks: 4, maxLength: 8)
        var raw: [[Int32]] = (0..<4).map { _ in [10, 11, 12, 13, 14, 15, 16, 17] }
        DelayPattern.apply(&raw, mask: mask)
        // codebook 0: forced at t=0 and t=5,6,7; real values kept at t=1..4
        XCTAssertEqual(raw[0], [DelayPattern.padTokenId, 11, 12, 13, 14,
                                 DelayPattern.padTokenId, DelayPattern.padTokenId, DelayPattern.padTokenId])
        // codebook 3: forced at t=0..3; real values kept at t=4..7
        XCTAssertEqual(raw[3], [DelayPattern.padTokenId, DelayPattern.padTokenId,
                                 DelayPattern.padTokenId, DelayPattern.padTokenId, 14, 15, 16, 17])
    }

    func testDeinterleaveRecoversCleanFrames() {
        // maxLength=8, numCodebooks=4 -> total_gen_len = 8-4 = 4.
        var raw: [[Int32]] = (0..<4).map { c in (0..<8).map { Int32($0 * 10 + c) } }
        let mask = DelayPattern.buildMask(numCodebooks: 4, maxLength: 8)
        DelayPattern.apply(&raw, mask: mask)
        let clean = DelayPattern.deinterleave(raw, frameCount: 4)
        XCTAssertEqual(clean.count, 4)
        for c in 0..<4 { XCTAssertEqual(clean[c].count, 4) }
        // codebook 0's clean frames are raw[0][1..<5] (pre-overwrite values, positions 1-4 are never forced)
        XCTAssertEqual(clean[0], [10, 20, 30, 40])
        // codebook 3's clean frames are raw[3][4..<8]
        XCTAssertEqual(clean[3], [43, 53, 63, 73])
    }
}
