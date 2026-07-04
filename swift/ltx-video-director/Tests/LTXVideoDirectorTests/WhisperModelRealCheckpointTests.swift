//
//  WhisperModelRealCheckpointTests.swift
//  LTXVideoDirectorTests
//
//  The end-to-end proof: loads the REAL whisper-large-v3-mlx checkpoint
//  (all 32 encoder + 32 decoder layers), runs WhisperMel + the full
//  encoder + the greedy decode loop against a REAL generated clip's real
//  speech audio, and checks the transcript — no mlx_whisper, no Python,
//  no RunPyBridge anywhere in this test. This is what ASRGate.swift will
//  eventually call instead of bridging to `run.py video asr-gate`.
//
//  HISTORICAL finding (now resolved — see testTranscribesRealClipWithFallbackEndToEndNatively
//  and WhisperDecoding.swift): this port's naive greedy decode used to
//  produce ", Hi, how are you?" for this clip's actual "嗨你好" audio,
//  cross-checked bit-identical against the REAL mlx_whisper.whisper.Whisper
//  class running the SAME naive strategy. That turned out to be two
//  compounding bugs, not an inherent limitation of naive greedy decoding:
//  (1) `WhisperTokenizer.languageCodesInOrder` was missing "yue" (99
//  entries instead of the real large-v3-mlx checkpoint's 100), which
//  shifted `no_timestamps` and every other trailing special token id by
//  one — feeding the decoder a subtly WRONG `<|notimestamps|>` token was
//  enough to corrupt the output on this short/ambiguous clip; and (2) real
//  `mlx_whisper.transcribe()` additionally uses temperature-fallback
//  retries + the full SuppressBlank/SuppressTokens/ApplyTimestampRules
//  filter stack, which `WhisperModel.transcribe` still doesn't implement
//  (`transcribeWithFallback` does). Fixing (1) alone already corrected the
//  naive decode below to "嗨你好" — this test asserts BIT-EXACT parity
//  against the real reference, not "does it say something Chinese."
//
//  Real GPU work (full 32-layer/1280-dim/20-head transformer, encoder +
//  autoregressive decode) — skipped if the checkpoint or clip aren't
//  present (CI / fresh clones), same pattern as this package's other
//  RealCheckpoint tests.
//

import Foundation
import MLX
import XCTest
@testable import LTXVideoDirector

final class WhisperModelRealCheckpointTests: XCTestCase {
    // Same checkpoint python/mlx-movie-director's ASR gate actually
    // transcribes with (see scripts/dump_whisper_real_encoder_block_reference.py).
    // NOTE: mlx-swift's MLX.loadArrays only reads .safetensors/.gguf, not
    // .npz — the HF cache ships weights.npz, so this points at a ONE-TIME
    // local conversion (`mx.save_file` from the loaded npz) sitting
    // alongside it. Not something this repo's dump scripts do automatically
    // (it's a 6GB fp32 file, not a small test fixture) — convert once via:
    //   python/venv/bin/python -c "import mlx.core as mx; from safetensors.numpy import save_file; import numpy as np; d = mx.load('<npz path>'); save_file({k: np.array(v.astype(mx.float32), copy=False) for k, v in d.items()}, '<npz path>'.replace('.npz','.safetensors'))"
    private let checkpointPath = NSString(string:
        "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/"
        + "snapshots/49e6aa286ad60c14352c404340ded53710378a11/weights.safetensors"
    ).expandingTildeInPath

    private let realClipPath = "/Users/huangziyu/proj/video_generation__output/t2i2v_20260702_072817/output_20260702_072848.mp4"

    // Unlike realClipPath above (whose fallback decode resolves at T=0 on
    // the first try), this clip's T=0 decode fails the avg_logprob gate
    // (-1.05 < -1.0), so `decode_with_fallback` actually retries at T=0.2 —
    // see scripts/dump_whisper_decode_with_fallback_retry_reference.py's
    // header for how this clip was found (the only one, out of 31 checked,
    // whose T=0 decode triggers a retry).
    private let retryClipPath = "/Users/huangziyu/proj/video_generation__output/t2i2v_20260702_064046/output_20260702_064158.mp4"

    private func refsDir(_ name: String) -> URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/\(name)")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/\(name)")
    }

    /// Extracts+resamples the real clip's audio via ffmpeg (test-only
    /// convenience — WhisperMel.loadAudio is the native AVFoundation path
    /// ASRGate.swift actually uses; this test cross-checks the model
    /// against a second, independent audio-decode route) and returns a
    /// (1, n_frames, 128) log-mel batch padded/trimmed to 30s exactly like
    /// mlx_whisper.audio.pad_or_trim(audio, N_SAMPLES) — real transcribe()
    /// always does this so the encoder sees its trained-on 1500-frame ctx.
    private func loadRealClipMel(clipPath: String? = nil) throws -> MLXArray {
        let wavPath = NSTemporaryDirectory() + "whisper_e2e_test_\(UUID().uuidString).wav"
        defer { try? FileManager.default.removeItem(atPath: wavPath) }
        let ffmpeg = Process()
        ffmpeg.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
        ffmpeg.arguments = ["-y", "-i", clipPath ?? realClipPath, "-vn", "-ar", "16000", "-ac", "1", wavPath]
        ffmpeg.standardOutput = FileHandle.nullDevice
        ffmpeg.standardError = FileHandle.nullDevice
        try ffmpeg.run()
        ffmpeg.waitUntilExit()
        try XCTSkipUnless(FileManager.default.fileExists(atPath: wavPath), "ffmpeg audio extraction failed — is it at /opt/homebrew/bin/ffmpeg?")

        let audio = try WAVReader.read(url: URL(fileURLWithPath: wavPath))
        var samples = audio.channels[0]
        let targetSamples = 30 * WhisperMel.sampleRate
        if samples.count < targetSamples {
            samples.append(contentsOf: [Float](repeating: 0, count: targetSamples - samples.count))
        } else if samples.count > targetSamples {
            samples = Array(samples[0..<targetSamples])
        }
        let mel = WhisperMel.logMelSpectrogram(audio: MLXArray(samples), nMels: .oneTwentyEight)
        return mel.expandedDimensions(axis: 0)
    }

    func testTranscribesRealClipEndToEndNatively() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: checkpointPath), "large-v3-mlx checkpoint not cached at \(checkpointPath)")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: realClipPath), "real test clip not present at \(realClipPath)")
        let refFile = refsDir("whisper_real_transcribe").appendingPathComponent("whisper_real_transcribe.json")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: refFile.path), "whisper_real_transcribe reference not dumped — run scripts/dump_whisper_real_transcribe_reference.py")
        let refData = try Data(contentsOf: refFile)
        guard let ref = try JSONSerialization.jsonObject(with: refData) as? [String: Any],
              let expectedText = ref["text"] as? String else {
            XCTFail("could not parse whisper_real_transcribe.json"); return
        }

        let melBatched = try loadRealClipMel()
        let model = try WhisperModel.load(checkpointPath: checkpointPath, nEncoderLayer: 32, nDecoderLayer: 32, nHead: 20)
        let transcript = model.transcribe(mel: melBatched, language: "zh", maxNewTokens: 32)

        print("native Swift transcript:", transcript)
        // Bit-exact parity against the REAL mlx_whisper.whisper.Whisper
        // class running the identical naive greedy strategy on the same
        // weights (see this file's header + the dump script) — proves the
        // full native pipeline (mel -> 32-layer encoder -> 32-layer greedy
        // decoder -> tokenizer decode) computes IDENTICALLY to the real
        // model, not just "produces plausible-looking text."
        XCTAssertEqual(transcript, expectedText)
    }

    func testDetectsRealLanguageEndToEndNatively() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: checkpointPath), "large-v3-mlx checkpoint not cached at \(checkpointPath)")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: realClipPath), "real test clip not present at \(realClipPath)")
        let refFile = refsDir("whisper_real_detect_language").appendingPathComponent("whisper_real_detect_language.json")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: refFile.path), "whisper_real_detect_language reference not dumped — run scripts/dump_whisper_real_detect_language_reference.py")
        let refData = try Data(contentsOf: refFile)
        guard let ref = try JSONSerialization.jsonObject(with: refData) as? [String: Any],
              let expectedCode = ref["detected_language_code"] as? String else {
            XCTFail("could not parse whisper_real_detect_language.json"); return
        }

        let melBatched = try loadRealClipMel()
        let model = try WhisperModel.load(checkpointPath: checkpointPath, nEncoderLayer: 32, nDecoderLayer: 32, nHead: 20)
        let detected = model.detectLanguage(mel: melBatched)

        // Bit-exact parity against real mlx_whisper.decoding.detect_language
        // on the same real weights/audio (scripts/dump_whisper_real_detect_language_reference.py).
        XCTAssertEqual(detected, expectedCode)
    }

    /// Closes the gap `testTranscribesRealClipEndToEndNatively` documents:
    /// `transcribeWithFallback` (WhisperDecoding.swift) ports the REAL
    /// `mlx_whisper.transcribe()` decode path — timestamps-allowed SOT +
    /// full SuppressBlank/SuppressTokens/ApplyTimestampRules filter stack +
    /// temperature-fallback retries — rather than the naive notimestamps
    /// decode above. On this clip, T=0 already succeeds (no fallback
    /// needed) and produces the CORRECT "嗨你好", unlike the naive decode's
    /// garbage — asserted bit-exact (tokens, not just text) against the
    /// real `DecodingTask.run` output (scripts/dump_whisper_decode_with_fallback_reference.py).
    func testTranscribesRealClipWithFallbackEndToEndNatively() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: checkpointPath), "large-v3-mlx checkpoint not cached at \(checkpointPath)")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: realClipPath), "real test clip not present at \(realClipPath)")
        let refFile = refsDir("whisper_decode_with_fallback").appendingPathComponent("whisper_decode_with_fallback.json")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: refFile.path), "whisper_decode_with_fallback reference not dumped — run scripts/dump_whisper_decode_with_fallback_reference.py")
        let refData = try Data(contentsOf: refFile)
        guard let ref = try JSONSerialization.jsonObject(with: refData) as? [String: Any],
              let expectedText = ref["text"] as? String,
              let expectedTokens = ref["tokens"] as? [Int],
              let expectedTemperature = ref["landed_temperature"] as? Double,
              let expectedAvgLogprob = ref["avg_logprob"] as? Double,
              let expectedNoSpeechProb = ref["no_speech_prob"] as? Double else {
            XCTFail("could not parse whisper_decode_with_fallback.json"); return
        }

        let melBatched = try loadRealClipMel()
        let model = try WhisperModel.load(checkpointPath: checkpointPath, nEncoderLayer: 32, nDecoderLayer: 32, nHead: 20)
        let result = model.transcribeWithFallback(mel: melBatched, language: "zh")

        print("native Swift fallback transcript:", result.text, "temperature:", result.temperature)
        XCTAssertEqual(result.temperature, expectedTemperature)
        XCTAssertEqual(result.tokens, expectedTokens)
        XCTAssertEqual(result.text, expectedText)
        XCTAssertEqual(result.avgLogprob, expectedAvgLogprob, accuracy: 1e-3)
        XCTAssertEqual(result.noSpeechProb, expectedNoSpeechProb, accuracy: 1e-3)
    }

    /// Unlike `testTranscribesRealClipWithFallbackEndToEndNatively` above
    /// (whose reference clip's T=0 decode already succeeds, so the retry
    /// *trigger* condition itself is never bit-exact-checked against a real
    /// failing case), this clip's T=0 decode genuinely fails the avg_logprob
    /// gate (-1.05 < -1.0). Two things are checked here, deliberately at
    /// different strictness:
    /// 1. Bit-exact: forcing `temperatures: [0.0]` (no retry attempted)
    ///    reproduces the real `DecodingTask.run(temperature=0)` output
    ///    exactly — proves the filter stack + greedy decode + avg_logprob
    ///    computation are correct on a clip where that number is actually
    ///    below the -1.0 threshold, not just plausible.
    /// 2. Structural, not bit-exact: with the real default `temperatures`
    ///    list, `transcribeWithFallback` must NOT stop at T=0 — it must
    ///    land at some T > 0. T>0 uses `mx.random.categorical` (stochastic
    ///    sampling from global PRNG state), which this repo has no
    ///    precedent for reproducing bit-exact across the Swift/Python MLX
    ///    boundary (confirmed empirically: re-running the Python reference
    ///    dump at T>0 produces a different landed temperature and text each
    ///    time) — so the retried text/tokens are intentionally NOT asserted.
    func testTranscribesRetryClipWithFallbackEndToEndNatively() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: checkpointPath), "large-v3-mlx checkpoint not cached at \(checkpointPath)")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: retryClipPath), "real retry-trigger test clip not present at \(retryClipPath)")
        let refFile = refsDir("whisper_decode_with_fallback_retry").appendingPathComponent("whisper_decode_with_fallback_retry.json")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: refFile.path), "whisper_decode_with_fallback_retry reference not dumped — run scripts/dump_whisper_decode_with_fallback_retry_reference.py")
        let refData = try Data(contentsOf: refFile)
        guard let ref = try JSONSerialization.jsonObject(with: refData) as? [String: Any],
              let expectedText = ref["text"] as? String,
              let expectedTokens = ref["tokens"] as? [Int],
              let expectedAvgLogprob = ref["avg_logprob"] as? Double,
              let expectedNoSpeechProb = ref["no_speech_prob"] as? Double,
              let expectedNeedsFallback = ref["needs_fallback"] as? Bool else {
            XCTFail("could not parse whisper_decode_with_fallback_retry.json"); return
        }
        // Sanity check the reference itself really does fail the gate — if
        // this ever flips false (e.g. re-dumped against a different
        // checkpoint), this clip stopped covering what its docstring claims.
        XCTAssertTrue(expectedNeedsFallback, "reference clip no longer triggers the retry gate at T=0 — pick a different clip")

        let melBatched = try loadRealClipMel(clipPath: retryClipPath)
        let model = try WhisperModel.load(checkpointPath: checkpointPath, nEncoderLayer: 32, nDecoderLayer: 32, nHead: 20)

        // (1) Bit-exact: T=0 only, no retry — deterministic greedy decode.
        let t0Result = model.transcribeWithFallback(mel: melBatched, language: "zh", temperatures: [0.0])
        print("native Swift T=0 (pre-retry) transcript:", t0Result.text, "avgLogprob:", t0Result.avgLogprob)
        XCTAssertEqual(t0Result.temperature, 0)
        XCTAssertEqual(t0Result.tokens, expectedTokens)
        XCTAssertEqual(t0Result.text, expectedText)
        XCTAssertEqual(t0Result.avgLogprob, expectedAvgLogprob, accuracy: 1e-3)
        XCTAssertEqual(t0Result.noSpeechProb, expectedNoSpeechProb, accuracy: 1e-3)
        XCTAssertLessThan(t0Result.avgLogprob, -1.0, "T=0 avgLogprob no longer below the fallback threshold")

        // (2) Structural: full default temperature ladder must actually
        // retry past T=0, not silently accept the failing T=0 result.
        let fallbackResult = model.transcribeWithFallback(mel: melBatched, language: "zh")
        print("native Swift fallback-landed transcript:", fallbackResult.text, "temperature:", fallbackResult.temperature)
        XCTAssertGreaterThan(fallbackResult.temperature, 0, "retry loop did not advance past T=0 despite T=0 failing the gate")
    }
}
