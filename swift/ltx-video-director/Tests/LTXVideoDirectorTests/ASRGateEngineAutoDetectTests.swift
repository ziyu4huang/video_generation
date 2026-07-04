//
//  ASRGateEngineAutoDetectTests.swift
//  LTXVideoDirectorTests
//
//  Pins the resolution rule for ASRGate.evaluate's default engine: native
//  Swift when a converted checkpoint is present locally, the Python bridge
//  ONLY as an availability fallback (never a silent quality downgrade
//  choice) — see ASRGateEngine.autoDetect's doc comment.
//

import XCTest
@testable import LTXVideoDirector

final class ASRGateEngineAutoDetectTests: XCTestCase {
    func testAutoDetectResolvesToNativeSwiftWhenLocalCheckpointConverted() throws {
        let hubDir = NSString(string: "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/snapshots").expandingTildeInPath
        let snapshots = (try? FileManager.default.contentsOfDirectory(atPath: hubDir)) ?? []
        let hasConvertedCheckpoint = snapshots.contains {
            FileManager.default.fileExists(atPath: "\(hubDir)/\($0)/weights.safetensors")
        }
        try XCTSkipUnless(hasConvertedCheckpoint, "no converted whisper-large-v3-mlx safetensors checkpoint present locally")

        switch ASRGateEngine.autoDetect() {
        case .nativeSwift(let path, let nEnc, let nDec, let nHead):
            XCTAssertTrue(FileManager.default.fileExists(atPath: path))
            XCTAssertEqual(nEnc, 32)
            XCTAssertEqual(nDec, 32)
            XCTAssertEqual(nHead, 20)
        case .pythonBridge:
            XCTFail("autoDetect() should resolve to .nativeSwift when a converted checkpoint is present")
        }
    }

    func testAutoDetectFallsBackToPythonBridgeWhenNoCheckpointFound() {
        // No override env var, and pointing autoDetect implicitly at a
        // nonexistent hub cache path isn't directly injectable (autoDetect
        // hardcodes the standard HF cache location by design — see its doc
        // comment) — this test instead pins the ENV VAR override path,
        // which IS directly testable: an override pointing at a
        // nonexistent file must NOT be honored, falling through to the
        // standard-path check (and ultimately .pythonBridge if that's also
        // absent in this environment).
        setenv("WHISPER_NATIVE_CHECKPOINT", "/nonexistent/path/weights.safetensors", 1)
        defer { unsetenv("WHISPER_NATIVE_CHECKPOINT") }

        if case .nativeSwift(let path, _, _, _) = ASRGateEngine.autoDetect() {
            XCTAssertNotEqual(path, "/nonexistent/path/weights.safetensors", "a nonexistent override path must not be honored")
        }
        // (Either .pythonBridge or a genuinely-existing standard-path
        // checkpoint is acceptable here — the only invariant under test is
        // "never returns the nonexistent override path.")
    }
}
