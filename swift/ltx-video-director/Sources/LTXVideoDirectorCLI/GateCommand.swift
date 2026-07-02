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

        func run() throws {
            var verdicts: [(path: String, verdict: VideoGateVerdict?)] = []
            for path in videos {
                let url = URL(fileURLWithPath: path)
                let v = try? VideoGate.evaluate(videoURL: url, expectVoice: expectVoice)
                verdicts.append((path, v))
            }

            if json {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                var arr: [[String: Any]] = []
                for (path, v) in verdicts {
                    if let data = v.flatMap({ try? encoder.encode($0) }),
                       var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                        obj["path"] = path
                        arr.append(obj)
                    } else {
                        arr.append(["path": path, "status": "FAIL", "reasons": ["could not read/probe video"]])
                    }
                }
                let data = try JSONSerialization.data(withJSONObject: arr, options: [.prettyPrinted, .sortedKeys])
                print(String(data: data, encoding: .utf8) ?? "[]")
            } else {
                for (path, v) in verdicts {
                    guard let v else {
                        print("❌ FAIL  \(path)\n     could not read/probe video")
                        continue
                    }
                    let icon = v.status == "PASS" ? "✅" : v.status == "WARN" ? "⚠️ " : "❌"
                    print("\(icon) \(v.status)  \(path)")
                    print("     \(v.reasons.joined(separator: "; "))")
                    let motionStr = v.motionMean.map { String(format: "%.3f", $0) } ?? "n/a"
                    print("     [\(v.width)x\(v.height) @ \(String(format: "%.1f", v.fps))fps, \(String(format: "%.1f", v.duration))s, audio=\(v.hasAudio ? String(format: "%.1fdBFS", v.meanDBFS) : "none"), ssim=\(String(format: "%.4f", v.minFrameSSIM))-\(String(format: "%.4f", v.maxFrameSSIM)), motion_mean=\(motionStr)]")
                }
            }

            let failed = verdicts.contains { (_, v) in
                v == nil || v?.status == "FAIL" || (strict && v?.status == "WARN")
            }
            if failed { throw ExitCode.failure }
        }
    }
}
