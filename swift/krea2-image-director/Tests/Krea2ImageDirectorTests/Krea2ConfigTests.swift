//
//  Krea2ConfigTests.swift
//  Krea2ImageDirectorTests
//
//  Placeholder until native component parity tests land (Phase 2 dump scripts
//  + ParityTests, mirroring swift/ltx-video-director/Tests).
//

import XCTest
@testable import Krea2ImageDirector

final class Krea2ConfigTests: XCTestCase {
    func testConfigMatchesPythonDefaults() {
        let c = Krea2Config()
        XCTAssertEqual(c.features, 6144)
        XCTAssertEqual(c.layers, 28)
        XCTAssertEqual(c.heads, 48)
        XCTAssertEqual(c.kvheads, 12)
        XCTAssertEqual(c.headDim, 128)
        XCTAssertEqual(c.ropeAxes, [32, 48, 48])
        XCTAssertEqual(c.ropeAxes.reduce(0, +), c.headDim, "rope axes must sum to headDim")
        XCTAssertEqual(c.theta, 1000.0, "Krea uses theta=1e3, not 1e4")
        XCTAssertEqual(c.defaultSteps, 8)
    }
}
