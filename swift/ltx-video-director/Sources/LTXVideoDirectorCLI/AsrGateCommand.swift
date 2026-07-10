//
//  AsrGateCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video asr-gate` — standalone CLI parity with `run.py video asr-gate`.
//  The engine itself (ASRGate.evaluate, native Swift/MLX Whisper by default)
//  already existed and was reachable only via `gate --asr-prompt`; this adds
//  the dedicated subcommand the Python CLI exposes, matching its flag names
//  and JSON output shape 1:1 (see ASRGate.swift's RawASRGateResult / the
//  Python `_run_audio_asr_gate` docstring in video-t2i2v.py).
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct AsrGate: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "asr-gate",
            abstract: "Transcribe a video's audio and check it against the prompt's 「...」 expected-speech marker."
        )

        @Option(help: "Path to the video file to check.")
        var video: String

        @Option(help: "Text prompt (expected speech is read from its 「...」 markers; defaults to 'zh' if no language is inferable).")
        var prompt: String

        @Option(help: "Write the result JSON to this path (also printed to stdout).")
        var jsonOut: String?

        @Option(help: "Additionally require the transcript to classify as this Chinese script variant: 'traditional' or 'simplified'.")
        var expectedScript: String?

        func run() throws {
            var scriptVariant: ScriptVariant? = nil
            if let expectedScript {
                guard let variant = ScriptVariant(rawValue: expectedScript.lowercased()), variant != .ambiguous else {
                    throw ValidationError("--expected-script must be 'traditional' or 'simplified', got '\(expectedScript)'")
                }
                scriptVariant = variant
            }

            let url = URL(fileURLWithPath: video)
            var payload: [String: Any]
            var hasError = false
            do {
                let v = try ASRGate.evaluate(videoURL: url, prompt: prompt, expectedScript: scriptVariant)
                payload = [
                    "detected_lang": v.detectedLang,
                    "transcript": v.transcript,
                    "expected_speech": v.expectedSpeech,
                    "lang_ok": v.langOK,
                    "content_match": v.contentMatch as Any,
                    "content_ratio": v.contentRatio as Any,
                    "status": v.status,
                    "reasons": v.reasons,
                ]
                hasError = v.status == "FAIL"
            } catch {
                payload = ["error": "\(error)"]
                hasError = true
            }

            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            let jsonString = String(data: data, encoding: .utf8) ?? "{}"
            print(jsonString)
            if let jsonOut {
                try jsonString.write(toFile: jsonOut, atomically: true, encoding: .utf8)
            }

            if hasError { throw ExitCode.failure }
        }
    }
}
