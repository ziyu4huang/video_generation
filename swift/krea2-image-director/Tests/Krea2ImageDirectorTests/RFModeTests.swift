//
//  RFModeTests.swift
//  Krea2ImageDirectorTests
//
//  GPU-free check that the RF-cache integrator modes (Gap 3) are wired and that
//  the legacy `fastRF` back-compat resolution behaves correctly. The integrator
//  math itself runs in the GPU cache loop (covered by real-silicon runs); this
//  test pins the enum surface + the resolve() semantics so the CLI/default paths
//  can't silently drift.
//

import XCTest
@testable import Krea2ImageDirector

final class RFModeTests: XCTestCase {
    func testRawValuesMatchUpstreamNames() {
        XCTAssertEqual(RFMode.flowturboPC.rawValue, "flowturbo_pc")
        XCTAssertEqual(RFMode.rfGamma.rawValue, "rf_gamma")
        XCTAssertEqual(RFMode.rfGammaRK2.rawValue, "rf_gamma_rk2")
        XCTAssertEqual(RFMode.linear.rawValue, "linear")
        XCTAssertEqual(RFMode.allCases.count, 4)
    }

    func testDefaultsToFlowturboPC() {
        // The recommended preset integrator must be the default.
        let d = Krea2StyleDefaults()
        XCTAssertEqual(d.rfMode, .flowturboPC)
    }

    func testFastRFBackCompatMapsToRfGamma() {
        // Legacy fastRF=true meant single-Euler + γ-blend → exactly rfGamma.
        XCTAssertEqual(RFMode.resolve(.flowturboPC, fastRF: true), .rfGamma)
    }

    func testFastRFFalseKeepsFlowturboPC() {
        XCTAssertEqual(RFMode.resolve(.flowturboPC, fastRF: false), .flowturboPC)
    }

    func testExplicitNonDefaultModeWinsOverFastRF() {
        // If the caller explicitly sets a non-default rfMode, fastRF must NOT
        // override it (fastRF is only an alias for the default).
        XCTAssertEqual(RFMode.resolve(.rfGammaRK2, fastRF: true), .rfGammaRK2)
        XCTAssertEqual(RFMode.resolve(.linear, fastRF: true), .linear)
        XCTAssertEqual(RFMode.resolve(.rfGamma, fastRF: true), .rfGamma)
    }
}
