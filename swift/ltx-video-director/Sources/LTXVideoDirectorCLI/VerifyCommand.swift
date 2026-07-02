//
//  VerifyCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video verify` — VLM keyframe verification against the original
//  prompt (semantic layer above the VLM-free `gate` command).
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct Verify: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify",
            abstract: "Extract keyframes and verify video quality/prompt-adherence with a local VLM (LM Studio)."
        )

        @Argument(help: "Video file to verify.")
        var video: String

        @Option(help: "Original generation prompt (used for prompt-adherence checking).")
        var prompt: String

        @Option(help: "Number of evenly spaced keyframes to sample.")
        var keyframes: Int = 4

        @Option(help: "VLM caption style. 'score' is the most reliable with local models; 'review' additionally checks prompt-element adherence but needs a model that follows its heavier JSON instructions closely.")
        var style: String = "score"

        @Option(help: "Minimum acceptable mean overall score (1-10) to pass.")
        var threshold: Int = 6

        @Flag(help: "Emit machine-readable JSON.")
        var json = false

        func run() throws {
            let url = URL(fileURLWithPath: video)
            let result = try VLMVerify.verify(videoURL: url, prompt: prompt, keyframeCount: keyframes, style: style)

            if json {
                let arr: [[String: Any]] = result.frames.map { f in
                    [
                        "time": f.time,
                        "overall": f.score?.overall ?? 0,
                        "artifacts": f.score?.artifacts ?? 0,
                        "prompt_adherence": f.score?.promptAdherence ?? 0,
                        "issues": f.score?.issues ?? [],
                        "summary": f.score?.summary ?? "",
                    ]
                }
                let payload: [String: Any] = [
                    "mean_overall": result.meanOverall,
                    "worst_overall": result.worstOverall,
                    "frames": arr,
                    "pass": result.worstOverall >= Double(threshold),
                ]
                let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
                print(String(data: data, encoding: .utf8) ?? "{}")
            } else {
                for f in result.frames {
                    if let s = f.score {
                        print("  t=\(String(format: "%.2f", f.time))s  overall=\(s.overall) artifacts=\(s.artifacts) adherence=\(s.promptAdherence)  \(s.summary)")
                        if !s.issues.isEmpty { print("     issues: \(s.issues.joined(separator: "; "))") }
                    } else {
                        print("  t=\(String(format: "%.2f", f.time))s  ⚠️ could not parse VLM response (is LM Studio running?)")
                    }
                }
                print("\nmean overall: \(String(format: "%.1f", result.meanOverall))  worst: \(String(format: "%.1f", result.worstOverall))")
            }

            if result.worstOverall < Double(threshold) {
                throw ExitCode.failure
            }
        }
    }
}
