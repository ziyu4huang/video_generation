//
//  CaptionScoreParserTests.swift
//  ImageGenUtilsTests
//
//  Pure-logic tests for the score JSON extraction (no network / no VLM).
//  The VLM often wraps JSON in ```json fences or prepends prose; the parser
//  must recover the JSON object in all these cases.
//

import XCTest
@testable import ImageGenUtils

final class CaptionScoreParserTests: XCTestCase {

    func testParsesCleanJSON() {
        let raw = """
        {"overall": 8, "detail": 7, "sharpness": 9, "composition": 8,
         "prompt_adherence": 7, "artifacts": 6,
         "issues": ["plasticky skin"], "strengths": ["good lighting"],
         "summary": "solid portrait"}
        """
        let score = CaptionScoreParser.parse(raw)
        XCTAssertEqual(score?.overall, 8)
        XCTAssertEqual(score?.artifacts, 6)
        XCTAssertEqual(score?.promptAdherence, 7)
        XCTAssertEqual(score?.issues, ["plasticky skin"])
        XCTAssertEqual(score?.summary, "solid portrait")
    }

    func testStripsMarkdownFences() {
        let raw = """
        ```json
        {"overall": 5, "detail": 4, "sharpness": 5, "composition": 5,
         "prompt_adherence": 5, "artifacts": 3,
         "issues": ["wrong finger count"], "strengths": [],
         "summary": "hand defect"}
        ```
        """
        let score = CaptionScoreParser.parse(raw)
        XCTAssertEqual(score?.overall, 5)
        XCTAssertEqual(score?.artifacts, 3)
        XCTAssertEqual(score?.issues, ["wrong finger count"])
    }

    func testRecoversJSONFromProsePrefix() {
        let raw = """
        Here is my assessment:

        {"overall": 9, "detail": 9, "sharpness": 8, "composition": 9,
         "prompt_adherence": 10, "artifacts": 9,
         "issues": [], "strengths": ["sharp eyes"],
         "summary": "clean"}
        Thanks!
        """
        let score = CaptionScoreParser.parse(raw)
        XCTAssertEqual(score?.overall, 9)
        XCTAssertEqual(score?.artifacts, 9)
        XCTAssertTrue(score?.issues.isEmpty ?? false)
    }

    func testHandlesNumericStrings() {
        // Some models emit scores as strings ("7" instead of 7).
        let raw = """
        {"overall": "7", "detail": "6", "sharpness": "7", "composition": "7",
         "prompt_adherence": "8", "artifacts": "7",
         "issues": [], "strengths": [], "summary": ""}
        """
        let score = CaptionScoreParser.parse(raw)
        XCTAssertEqual(score?.overall, 7)
        XCTAssertEqual(score?.artifacts, 7)
    }

    func testPassesThreshold() {
        let score = CaptionScore(
            overall: 8, detail: 7, sharpness: 7, composition: 7,
            promptAdherence: 7, artifacts: 8,
            issues: [], strengths: [], summary: "", rawJSON: "{}"
        )
        XCTAssertTrue(score.passes(threshold: 7))
        XCTAssertFalse(score.passes(threshold: 9))   // overall 8 < 9
    }

    func testFailsOnLowArtifacts() {
        // High overall but low artifacts (plasticky skin) must FAIL — the
        // inverted artifacts dimension is the whole point of the defect block.
        let score = CaptionScore(
            overall: 9, detail: 9, sharpness: 9, composition: 9,
            promptAdherence: 9, artifacts: 4,
            issues: ["plasticky skin"], strengths: [], summary: "", rawJSON: "{}"
        )
        XCTAssertFalse(score.passes(threshold: 7))
    }

    func testReturnsNilOnGarbage() {
        XCTAssertNil(CaptionScoreParser.parse("not json at all"))
        XCTAssertNil(CaptionScoreParser.parse(""))
    }
}
