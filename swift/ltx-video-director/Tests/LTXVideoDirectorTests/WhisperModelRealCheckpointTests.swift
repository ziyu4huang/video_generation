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
//  IMPORTANT finding: this port's naive greedy decode (no beam search, no
//  temperature-fallback retries — see WhisperModel.swift's header) produces
//  ", Hi, how are you?" for this clip's actual "嗨你好" audio — an ENGLISH
//  translation, not a zh transcription, despite forcing the zh language
//  token. Cross-checked against the REAL mlx_whisper.whisper.Whisper class
//  running the IDENTICAL naive greedy strategy on the SAME real weights
//  (scripts/dump_whisper_real_transcribe_reference.py) — Python produces
//  the EXACT SAME generated token ids. This is not a Swift bug: it's what
//  this real checkpoint's naive greedy decoding actually does on this
//  short/ambiguous clip. mlx_whisper's own polished `transcribe()` (which
//  this test does NOT reimplement) uses temperature-fallback retries +
//  additional logit filters to get a better result — a real follow-up if
//  this port needs production-quality output, not a correctness bug in
//  what's implemented today. This test therefore asserts BIT-EXACT parity
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
    private func loadRealClipMel() throws -> MLXArray {
        let wavPath = NSTemporaryDirectory() + "whisper_e2e_test_\(UUID().uuidString).wav"
        defer { try? FileManager.default.removeItem(atPath: wavPath) }
        let ffmpeg = Process()
        ffmpeg.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
        ffmpeg.arguments = ["-y", "-i", realClipPath, "-vn", "-ar", "16000", "-ac", "1", wavPath]
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
}
