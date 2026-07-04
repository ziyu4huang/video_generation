//
//  WhisperTokenizerTests.swift
//  LTXVideoDirectorTests
//
//  Parity against REAL mlx_whisper.tokenizer.get_tokenizer output — both
//  the closed-form special-token ids (language/task/notimestamps) and the
//  decode-only path (BPE rank -> bytes -> UTF-8).
//

import XCTest
@testable import LTXVideoDirector

final class WhisperTokenizerTests: XCTestCase {
    func testSotSequenceMatchesRealTokenizerForEnglish() {
        // python: get_tokenizer(multilingual=True, language="en", task="transcribe")
        //   .sot_sequence_including_notimestamps == (50258, 50259, 50359, 50363)
        XCTAssertEqual(WhisperTokenizer.sotSequence(language: "en"), [50258, 50259, 50359, 50363])
    }

    func testSotSequenceMatchesRealTokenizerForChinese() {
        // python: same call with language="zh" -> (50258, 50260, 50359, 50363)
        // This is the exact prefix python/mlx-movie-director's ASR gate implicitly
        // relies on when mlx_whisper transcribes with language=None (auto-detect)
        // and later checks detected_lang against zh — this is the token sequence
        // a forced-zh decode would use.
        XCTAssertEqual(WhisperTokenizer.sotSequence(language: "zh"), [50258, 50260, 50359, 50363])
    }

    func testSotSequenceMatchesRealTokenizerForJapanese() {
        // python: same call with language="ja" -> (50258, 50266, 50359, 50363)
        XCTAssertEqual(WhisperTokenizer.sotSequence(language: "ja"), [50258, 50266, 50359, 50363])
    }

    func testEndOfTextMatchesRealTokenizer() {
        XCTAssertEqual(WhisperTokenizer.endOfText, 50257)
    }

    func testDecodeMatchesRealTiktokenOutput() {
        // python: get_tokenizer(...).decode([1234, 5678]) == "но James"
        XCTAssertEqual(WhisperTokenizer.decode([1234, 5678]), "но James")
    }

    func testDecodeRoundTripsRealChineseEncodeOutput() {
        // python: get_tokenizer(...).encode("嗨你好") == [6083, 101, 26410]
        // (encode not ported — this test only exercises OUR decode direction
        // on real encoder output ids, per this file's "decode-only" scope)
        XCTAssertEqual(WhisperTokenizer.decode([6083, 101, 26410]), "嗨你好")
    }

    func testDecodeSkipsSpecialTokens() {
        // Special-token ids (>= numBaseTokens) must be silently dropped, matching
        // mlx_whisper's own transcription path (it strips special tokens before
        // returning `result["text"]`).
        let withSpecials = [WhisperTokenizer.startOfTranscript, 6083, 101, 26410, WhisperTokenizer.endOfText]
        XCTAssertEqual(WhisperTokenizer.decode(withSpecials), "嗨你好")
    }
}
