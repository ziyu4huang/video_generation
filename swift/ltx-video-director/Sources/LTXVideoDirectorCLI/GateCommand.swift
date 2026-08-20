//
//  GateCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video gate` — native (VLM-free) video/image/voice quality gateway.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct Gate: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "gate",
            abstract: "Run the basic video/image/voice quality gateway (no VLM, no network)."
        )

        @Argument(help: "Video file(s) to gate.")
        var videos: [String]

        @Flag(help: "Emit machine-readable JSON (one array).")
        var json = false

        @Flag(inversion: .prefixedNo, help: "Expect an audio/voice track (FAIL if missing).")
        var expectVoice = true

        @Flag(help: "Treat WARN as failure too (exit 1).")
        var strict = false

        @Option(help: "Also run the ASR voice-content gate (bridges to mlx_whisper — slower). Pass the original generation prompt; expected speech/language is read from its 「...」 markers.")
        var asrPrompt: String?

        @Option(help: "With --asr-prompt, additionally require the transcript to classify as this Chinese script variant: 'traditional' or 'simplified'.")
        var expectedScript: String?

        func run() throws {
            // An unrecognized --expected-script used to silently become `nil`
            // via `ScriptVariant(rawValue:)`'s Optional init, which DISABLES
            // the whole script-mismatch check rather than erroring — the
            // exact zh-CN-vs-zh-TW bug this flag exists to catch would then
            // slip through with no warning the flag value was invalid (found
            // by s2-agent-ext-ltx-self-improve's review lane, 2026-07-05).
            // "ambiguous" is a real ScriptVariant case but not a meaningful
            // EXPECTATION to assert, so it's rejected here too.
            var scriptVariant: ScriptVariant? = nil
            if let expectedScript {
                guard let variant = ScriptVariant(rawValue: expectedScript.lowercased()), variant != .ambiguous else {
                    throw ValidationError("--expected-script must be 'traditional' or 'simplified', got '\(expectedScript)'")
                }
                scriptVariant = variant
            }

            var verdicts: [(path: String, verdict: VideoGateVerdict?, asr: ASRGateVerdict?)] = []
            for path in videos {
                let url = URL(fileURLWithPath: path)
                let v = try? VideoGate.evaluate(videoURL: url, expectVoice: expectVoice)
                var asr: ASRGateVerdict? = nil
                if let asrPrompt {
                    asr = try? ASRGate.evaluate(videoURL: url, prompt: asrPrompt, expectedScript: scriptVariant)
                }
                verdicts.append((path, v, asr))
            }

            if json {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                // VideoGateVerdict.meanDBFS is -.infinity for audio-less clips
                // (see VideoGate.evaluate) — JSONEncoder's default strategy
                // THROWS EncodingError.invalidValue on any non-finite Double,
                // which `try? encoder.encode($0)` below then silently
                // swallowed into the misleading "could not read/probe video"
                // reason (confirmed via a real A/B upscale run: a genuinely
                // valid, ffprobe-readable video-only mp4 from native-upscale
                // reported this exact false error). Encoding -inf as a string
                // keeps the verdict itself intact instead of losing it.
                encoder.nonConformingFloatEncodingStrategy = .convertToString(
                    positiveInfinity: "inf", negativeInfinity: "-inf", nan: "nan")
                var arr: [[String: Any]] = []
                for (path, v, asr) in verdicts {
                    if let v, let data = try? encoder.encode(v),
                       var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                        obj["path"] = path
                        if let asr, let asrData = try? encoder.encode(asr),
                           let asrObj = (try? JSONSerialization.jsonObject(with: asrData)) as? [String: Any] {
                            obj["asr"] = asrObj
                        }
                        arr.append(obj)
                    } else {
                        arr.append(["path": path, "status": "FAIL", "reasons": ["could not read/probe video"]])
                    }
                }
                let data = try JSONSerialization.data(withJSONObject: arr, options: [.prettyPrinted, .sortedKeys])
                print(String(data: data, encoding: .utf8) ?? "[]")
            } else {
                for (path, v, asr) in verdicts {
                    guard let v else {
                        print("❌ FAIL  \(path)\n     could not read/probe video")
                        continue
                    }
                    let icon = v.status == "PASS" ? "✅" : v.status == "WARN" ? "⚠️ " : "❌"
                    print("\(icon) \(v.status)  \(path)")
                    print("     \(v.reasons.joined(separator: "; "))")
                    let motionStr = v.motionMean.map { String(format: "%.3f", $0) } ?? "n/a"
                    print("     [\(v.width)x\(v.height) @ \(String(format: "%.1f", v.fps))fps, \(String(format: "%.1f", v.duration))s, audio=\(v.hasAudio ? String(format: "%.1fdBFS", v.meanDBFS) : "none"), ssim=\(String(format: "%.4f", v.minFrameSSIM))-\(String(format: "%.4f", v.maxFrameSSIM)), motion_mean=\(motionStr)]")
                    if let asr {
                        let asrIcon = asr.status == "PASS" ? "✅" : asr.status == "WARN" ? "⚠️ " : "❌"
                        print("     ASR \(asrIcon) \(asr.status)  \(asr.reasons.joined(separator: "; "))")
                        print("     transcript: \(asr.transcript)")
                    }
                }
            }

            var failed = false
            for (_, v, asr) in verdicts {
                if v == nil || v?.status == "FAIL" || asr?.status == "FAIL" { failed = true }
                if strict && (v?.status == "WARN" || asr?.status == "WARN") { failed = true }
            }
            if failed { throw ExitCode.failure }
        }
    }
}
