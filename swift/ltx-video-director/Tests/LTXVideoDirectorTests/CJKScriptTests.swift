//
//  CJKScriptTests.swift
//  LTXVideoDirectorTests
//
//  Traditional-vs-Simplified classification is the crux of the zh-TW voice
//  gate (Whisper's `detected_lang` only ever says generic "zh") — these pin
//  the behavior against known Traditional/Simplified phrases so a future
//  table edit can't silently invert the classification.
//

import XCTest
@testable import LTXVideoDirector

final class CJKScriptTests: XCTestCase {
    func testClassifiesTraditionalPhrase() {
        // "Hello, how are you" — all characters here (你好嗎) are the same
        // codepoints in both scripts (no discriminating chars), so use a
        // phrase that actually differs: Traditional "電腦" vs Simplified "电脑".
        let result = CJKScript.classify("我的電腦壞了，這台車也開不動")
        XCTAssertEqual(result.variant, .traditional)
        XCTAssertGreaterThan(result.traditionalHits, 0)
        XCTAssertEqual(result.simplifiedHits, 0)
    }

    func testClassifiesSimplifiedPhrase() {
        let result = CJKScript.classify("我的电脑坏了，这台车也开不动")
        XCTAssertEqual(result.variant, .simplified)
        XCTAssertGreaterThan(result.simplifiedHits, 0)
        XCTAssertEqual(result.traditionalHits, 0)
    }

    func testAmbiguousWhenNoDiscriminatingCharacters() {
        // Every character here is unified across both scripts.
        let result = CJKScript.classify("你好我是人")
        XCTAssertEqual(result.variant, .ambiguous)
        XCTAssertEqual(result.simplifiedHits, 0)
        XCTAssertEqual(result.traditionalHits, 0)
    }

    func testAmbiguousOnEmptyString() {
        let result = CJKScript.classify("")
        XCTAssertEqual(result.variant, .ambiguous)
    }

    func testMixedScriptTieIsAmbiguous() {
        // One traditional-only char, one simplified-only char -> tie.
        let result = CJKScript.classify("電电")
        XCTAssertEqual(result.variant, .ambiguous)
        XCTAssertEqual(result.simplifiedHits, 1)
        XCTAssertEqual(result.traditionalHits, 1)
    }

    func testTaiwanNameClassifiesTraditional() {
        // 灣 (Traditional) vs 湾 (Simplified) is exactly the character this
        // whole feature exists to catch — "台灣" vs "台湾".
        let result = CJKScript.classify("台灣的天氣很好")
        XCTAssertEqual(result.variant, .traditional)
    }
}
