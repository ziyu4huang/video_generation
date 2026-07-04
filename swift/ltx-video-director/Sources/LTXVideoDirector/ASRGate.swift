//
//  ASRGate.swift
//  LTXVideoDirector
//
//  ASR-based voice-content verification: does the generated clip actually
//  say the expected line, in the expected language/script? AudioProbe.swift
//  only measures loudness/silence — it cannot tell "clear audible nonsense"
//  from "clear audible correct speech".
//
//  DEFAULT ENGINE IS NATIVE SWIFT/MLX — no Python, no RunPyBridge, no
//  mlx_whisper: WhisperMel (feature extraction) + WhisperEncoder (32-layer
//  self-attention) + WhisperDecoder (32-layer causal+cross-attention) +
//  WhisperTokenizer (tiktoken decode) + WhisperModel (checkpoint loader +
//  greedy decode loop + real language auto-detection). Every stage is
//  bit-exact-verified against the real production checkpoint
//  (WhisperModelRealCheckpointTests, WhisperEncoderRealCheckpointTests,
//  WhisperDecoderRealCheckpointTests) — see PLAN.md Phase 3 / docs/TODO.md
//  for the full port history.
//
//  `.autoDetect()` (the default) resolves to `.nativeSwift` when a
//  converted checkpoint is present at the standard local path (see
//  ASRGateEngine.autoDetect's doc comment for the exact resolution rule),
//  falling back to `.pythonBridge` only when that native checkpoint isn't
//  set up on this machine — never for quality reasons.
//
//  Transcription goes through `WhisperModel.transcribeWithFallback`
//  (WhisperDecoding.swift) — the REAL `mlx_whisper.transcribe()` decode
//  path (timestamps-allowed SOT + SuppressBlank/SuppressTokens/
//  ApplyTimestampRules + temperature-fallback retries), not the simpler
//  notimestamps-forced `WhisperModel.transcribe`. Previously-documented
//  quality gap ("Hi, Ni Hao" instead of "嗨你好" on this gate's reference
//  clip) is now closed and bit-exact-verified against the real checkpoint
//  (WhisperModelRealCheckpointTests) — it turned out to be two compounding
//  bugs, not an inherent naive-decode limitation: (1) missing the
//  temperature-fallback + full logit-filter stack, AND (2) a genuine
//  off-by-one in `WhisperTokenizer.languageCodesInOrder` (99 entries
//  instead of the real checkpoint's 100 — see that constant's header),
//  which shifted every trailing special token id (`no_timestamps` etc.) by
//  one. Fixing (2) alone already corrected even the naive decode.
//

import Foundation
import MLX

public struct ASRGateVerdict: Codable {
    public let status: String  // PASS / WARN / FAIL
    public let reasons: [String]
    public let detectedLang: String
    public let transcript: String
    public let expectedSpeech: String
    public let langOK: Bool
    public let contentMatch: Bool?
    public let contentRatio: Double?
    public let scriptClassification: ScriptClassification?
    public let expectedScript: ScriptVariant?
}

/// Raw JSON shape returned by `run.py video asr-gate --json-out ...`.
private struct RawASRGateResult: Codable {
    let error: String?
    let detected_lang: String?
    let expected_lang: String?
    let transcript: String?
    let expected_speech: String?
    let lang_ok: Bool?
    let content_match: Bool?
    let content_ratio: Double?
}

public enum ASRGateError: Error, CustomStringConvertible {
    case bridgeFailed(String)
    case malformedResult(String)

    public var description: String {
        switch self {
        case .bridgeFailed(let s): return "ASR gate bridge failed: \(s)"
        case .malformedResult(let s): return "ASR gate returned unparseable JSON: \(s)"
        }
    }
}

public enum ASRGateEngine {
    /// 100% native Swift/MLX — no Python, no RunPyBridge, no mlx_whisper.
    /// See this file's header for the honest quality caveat vs. the bridge.
    case nativeSwift(checkpointPath: String, nEncoderLayer: Int = 32, nDecoderLayer: Int = 32, nHead: Int = 20)
    /// Bridges to `run.py video asr-gate` (mlx_whisper's polished,
    /// temperature-fallback `transcribe()`) — used as the automatic
    /// fallback by `.autoDetect()` when no local native checkpoint is set
    /// up, or explicitly if you want the higher-fidelity bridge path.
    case pythonBridge

    /// The default engine: `.nativeSwift` if a converted checkpoint exists
    /// at `~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/
    /// snapshots/*/weights.safetensors` (or `WHISPER_NATIVE_CHECKPOINT` env
    /// var override) — mlx-swift's MLX.loadArrays only reads
    /// .safetensors/.gguf, not the .npz the HF cache actually ships, so
    /// this is a ONE-TIME local conversion, not something auto-detect
    /// converts on the fly (see WhisperModelRealCheckpointTests.swift for
    /// the exact conversion command). Falls back to `.pythonBridge` only
    /// when that native checkpoint genuinely isn't present — never a
    /// silent quality downgrade choice.
    public static func autoDetect(nEncoderLayer: Int = 32, nDecoderLayer: Int = 32, nHead: Int = 20) -> ASRGateEngine {
        if let override = ProcessInfo.processInfo.environment["WHISPER_NATIVE_CHECKPOINT"],
           FileManager.default.fileExists(atPath: override) {
            return .nativeSwift(checkpointPath: override, nEncoderLayer: nEncoderLayer, nDecoderLayer: nDecoderLayer, nHead: nHead)
        }
        let fm = FileManager.default
        let hubDir = NSString(string: "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/snapshots").expandingTildeInPath
        if let snapshots = try? fm.contentsOfDirectory(atPath: hubDir) {
            for snapshot in snapshots {
                let candidate = "\(hubDir)/\(snapshot)/weights.safetensors"
                if fm.fileExists(atPath: candidate) {
                    return .nativeSwift(checkpointPath: candidate, nEncoderLayer: nEncoderLayer, nDecoderLayer: nDecoderLayer, nHead: nHead)
                }
            }
        }
        return .pythonBridge
    }
}

public enum ASRGate {
    /// Run the ASR content/language gate against `videoURL`, checking the
    /// transcript against `prompt`'s 「...」 expected-speech marker (if any).
    /// `expectedScript` additionally requires the transcript to classify as
    /// Traditional (or Simplified) Chinese specifically — pass nil to skip
    /// that check (e.g. non-Chinese expected speech). `engine` defaults to
    /// `.autoDetect()` — native Swift when a local checkpoint is set up,
    /// the Python bridge only as an availability fallback (see
    /// `ASRGateEngine.autoDetect`'s doc comment).
    public static func evaluate(
        videoURL: URL, prompt: String, expectedScript: ScriptVariant? = nil,
        engine: ASRGateEngine = .autoDetect()
    ) throws -> ASRGateVerdict {
        switch engine {
        case .pythonBridge:
            return try evaluateViaPythonBridge(videoURL: videoURL, prompt: prompt, expectedScript: expectedScript)
        case .nativeSwift(let checkpointPath, let nEncoderLayer, let nDecoderLayer, let nHead):
            return try evaluateViaNativeSwift(
                videoURL: videoURL, prompt: prompt, expectedScript: expectedScript,
                checkpointPath: checkpointPath, nEncoderLayer: nEncoderLayer, nDecoderLayer: nDecoderLayer, nHead: nHead
            )
        }
    }

    private static func evaluateViaPythonBridge(videoURL: URL, prompt: String, expectedScript: ScriptVariant?) throws -> ASRGateVerdict {
        let tmpJSON = FileManager.default.temporaryDirectory
            .appendingPathComponent("asr-gate-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmpJSON) }

        let args = ["video", "asr-gate", "--video", videoURL.path, "--prompt", prompt, "--json-out", tmpJSON.path]
        do {
            _ = try RunPyBridge.run(args, stream: false)
        } catch RunPyBridgeError.processFailed(let result) {
            // asr-gate exits 1 on an internal error dict (e.g. mlx_whisper
            // missing) — the JSON is still written and worth surfacing.
            guard FileManager.default.fileExists(atPath: tmpJSON.path) else {
                throw ASRGateError.bridgeFailed(result.stderr)
            }
        }

        let data = try Data(contentsOf: tmpJSON)
        let raw: RawASRGateResult
        do {
            raw = try JSONDecoder().decode(RawASRGateResult.self, from: data)
        } catch {
            throw ASRGateError.malformedResult(String(data: data, encoding: .utf8) ?? "<binary>")
        }

        if let error = raw.error {
            return ASRGateVerdict(
                status: "FAIL", reasons: ["ASR gate error: \(error)"],
                detectedLang: "", transcript: "", expectedSpeech: "",
                langOK: false, contentMatch: nil, contentRatio: nil,
                scriptClassification: nil, expectedScript: expectedScript
            )
        }

        let transcript = raw.transcript ?? ""
        let detectedLang = raw.detected_lang ?? ""
        let expectedLang = raw.expected_lang ?? "zh"
        let langOK = raw.lang_ok ?? false
        return buildVerdict(
            transcript: transcript, detectedLang: detectedLang, expectedLang: expectedLang,
            langOK: langOK, contentMatch: raw.content_match, contentRatio: raw.content_ratio,
            expectedSpeech: raw.expected_speech ?? "", expectedScript: expectedScript
        )
    }

    /// Same decision logic as the Python path (`_run_audio_asr_gate`
    /// exactly: language check + ≥50% CJK-character content overlap), but
    /// runs transcription through WhisperModel (100% native) instead of
    /// bridging to `run.py video asr-gate`.
    private static func evaluateViaNativeSwift(
        videoURL: URL, prompt: String, expectedScript: ScriptVariant?,
        checkpointPath: String, nEncoderLayer: Int, nDecoderLayer: Int, nHead: Int
    ) throws -> ASRGateVerdict {
        let (expectedSpeech, expectedLangRaw) = extractExpectedSpeech(from: prompt)
        let expectedLang = expectedLangRaw.isEmpty ? "zh" : expectedLangRaw

        var samples = try WhisperMel.loadAudio(url: videoURL)
        let targetSamples = 30 * WhisperMel.sampleRate
        if samples.count < targetSamples {
            samples.append(contentsOf: [Float](repeating: 0, count: targetSamples - samples.count))
        } else if samples.count > targetSamples {
            samples = Array(samples[0..<targetSamples])
        }
        let mel = WhisperMel.logMelSpectrogram(audio: MLXArray(samples), nMels: .oneTwentyEight)
        let melBatched = mel.expandedDimensions(axis: 0)
        let model = try WhisperModel.load(checkpointPath: checkpointPath, nEncoderLayer: nEncoderLayer, nDecoderLayer: nDecoderLayer, nHead: nHead)

        // Real language auto-detection (mlx_whisper.decoding.detect_language
        // port — WhisperModel.detectLanguage), mirroring the Python bridge's
        // own auto-detect-then-compare check rather than trivially trusting
        // whatever language was force-decoded.
        let detectedLang = model.detectLanguage(mel: melBatched)
        let chineseLangCodes: Set<String> = ["zh", "yue", "wuu"]  // matches video-t2i2v.py's _CHINESE_LANG_CODES
        let langOK = expectedLang == "zh" ? chineseLangCodes.contains(detectedLang) : (detectedLang == expectedLang)

        let transcript = model.transcribeWithFallback(mel: melBatched, language: expectedLang).text
        let contentRatio = contentOverlapRatio(expected: expectedSpeech, transcript: transcript)
        return buildVerdict(
            transcript: transcript, detectedLang: detectedLang, expectedLang: expectedLang,
            langOK: langOK, contentMatch: contentRatio.map { $0 >= 0.5 }, contentRatio: contentRatio,
            expectedSpeech: expectedSpeech, expectedScript: expectedScript
        )
    }

    /// Mirrors video-t2i2v.py's `_extract_expected_speech` exactly: text
    /// inside 「...」 brackets, and a CJK-vs-kana codepoint sniff for the
    /// expected language.
    private static func extractExpectedSpeech(from prompt: String) -> (speech: String, lang: String) {
        guard let openRange = prompt.range(of: "「"), let closeRange = prompt.range(of: "」", range: openRange.upperBound..<prompt.endIndex) else {
            return ("", "")
        }
        let speech = String(prompt[openRange.upperBound..<closeRange.lowerBound])
        if speech.isEmpty { return ("", "") }
        let hasCJK = speech.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) || (0x3400...0x4DBF).contains($0.value) }
        if hasCJK { return (speech, "zh") }
        let hasKana = speech.unicodeScalars.contains { (0x3041...0x309F).contains($0.value) || (0x30A0...0x30FF).contains($0.value) }
        if hasKana { return (speech, "ja") }
        return (speech, "")
    }

    /// Mirrors `_run_audio_asr_gate`'s content-match ratio exactly: strip
    /// to CJK-or-word characters, then fraction of expected characters
    /// present anywhere in the transcript.
    private static func contentOverlapRatio(expected: String, transcript: String) -> Double? {
        guard !expected.isEmpty, !transcript.isEmpty else { return nil }
        func cjkOrWord(_ s: String) -> [Character] {
            s.filter { ch in
                ch.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) || (0x3400...0x4DBF).contains($0.value) } || ch.isLetter || ch.isNumber
            }
        }
        let exp = cjkOrWord(expected)
        guard !exp.isEmpty else { return nil }
        let trn = Set(cjkOrWord(transcript))
        let matched = exp.filter { trn.contains($0) }.count
        return Double(matched) / Double(exp.count)
    }

    private static func buildVerdict(
        transcript: String, detectedLang: String, expectedLang: String, langOK: Bool,
        contentMatch: Bool?, contentRatio: Double?, expectedSpeech: String, expectedScript: ScriptVariant?
    ) -> ASRGateVerdict {
        var reasons: [String] = []
        var status = "PASS"
        func escalate(_ s: String, _ reason: String) {
            reasons.append(reason)
            if s == "FAIL" { status = "FAIL" }
            else if s == "WARN" && status != "FAIL" { status = "WARN" }
        }

        if !langOK {
            escalate("FAIL", "detected language '\(detectedLang)' does not match expected '\(expectedLang)'")
        }
        if let match = contentMatch, !match {
            let ratio = contentRatio.map { String(format: "%.2f", $0) } ?? "n/a"
            escalate("FAIL", "transcript content overlap too low (ratio=\(ratio), need >=0.50)")
        }

        var classification: ScriptClassification? = nil
        if let expectedScript, !transcript.isEmpty {
            let c = CJKScript.classify(transcript)
            classification = c
            if c.variant == .ambiguous {
                escalate("WARN", "could not classify transcript script (no discriminating characters found)")
            } else if c.variant != expectedScript {
                escalate("FAIL", "transcript script is \(c.variant.rawValue), expected \(expectedScript.rawValue) (simplified_hits=\(c.simplifiedHits), traditional_hits=\(c.traditionalHits))")
            }
        }

        if reasons.isEmpty { reasons.append("ok") }

        return ASRGateVerdict(
            status: status, reasons: reasons,
            detectedLang: detectedLang, transcript: transcript, expectedSpeech: expectedSpeech,
            langOK: langOK, contentMatch: contentMatch, contentRatio: contentRatio,
            scriptClassification: classification, expectedScript: expectedScript
        )
    }
}
