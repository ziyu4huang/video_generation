//
//  CaptionCommand.swift
//  ZImageDirectorCLI
//
//  `zimage caption <IMAGE>` — VLM caption/score via LM Studio Qwen3-VL.
//

import ArgumentParser
import Foundation
import ImageGenUtils
import ZImageDirector

extension ZImageCLI {
    struct Caption: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "caption",
            abstract: "Caption or score an image via local Qwen3-VL (LM Studio)."
        )

        @Argument(help: "Path to the image to caption.")
        var image: String

        @Option(help: "Style: default|photography|t2i|score|review (score/review emit JSON).")
        var style: String = "default"

        @Option(help: "Original T2I prompt (required for --style review to check adherence).")
        var prompt: String?

        @Option(help: "LM Studio API URL.")
        var apiUrl: String = CaptionClient.defaultAPIURL

        @Option(help: "VLM model id (in LM Studio).")
        var model: String = CaptionClient.defaultModel

        @Option(help: "Max output tokens.")
        var maxTokens: Int = 2048

        @Option(help: "Output path for the raw caption text (default: stdout).")
        var output: String?

        @Flag(help: "Parse the JSON score and exit non-zero if overall < threshold (for scripting/self-critique).")
        var scoreCheck: Bool = false

        @Option(help: "Score threshold for --score-check (default 7).")
        var threshold: Int = 7

        func run() throws {
            let imageURL = URL(fileURLWithPath: image)
            guard FileManager.default.fileExists(atPath: imageURL.path) else {
                throw ValidationError("Image not found: \(image)")
            }
            let fileName = URL(fileURLWithPath: image).lastPathComponent
            print("caption: \(fileName) [style=\(style), model=\(model)]")
            let raw = try CaptionClient.caption(
                imageURL: imageURL, style: style, prompt: prompt,
                apiURL: apiUrl, model: model, maxTokens: maxTokens
            )
            print("")
            if style == "score" || style == "review" {
                try printScore(raw)
            } else {
                print(raw)
                if let outPath = output {
                    try raw.write(toFile: outPath, atomically: true, encoding: .utf8)
                    print("\n(saved to \(outPath))")
                }
            }
        }

        /// Parse + pretty-print a score/review JSON response, optionally
        /// writing it to disk and enforcing a pass/fail exit code.
        private func printScore(_ raw: String) throws {
            guard let parsed = CaptionClient.parseScore(raw) else {
                print("⚠️ could not parse JSON; raw response:")
                print(raw)
                return
            }
            let verdict = parsed.passes(threshold: threshold) ? "PASS ✅" : "FAIL ❌"
            print("VLM score: overall=\(parsed.overall) detail=\(parsed.detail) " +
                  "sharp=\(parsed.sharpness) comp=\(parsed.composition) " +
                  "adhere=\(parsed.promptAdherence) artifacts=\(parsed.artifacts) " +
                  "— \(verdict) (threshold=\(threshold))")
            if !parsed.issues.isEmpty {
                print("  issues   : \(parsed.issues.joined(separator: "; "))")
            }
            if !parsed.strengths.isEmpty {
                print("  strengths: \(parsed.strengths.joined(separator: "; "))")
            }
            if !parsed.summary.isEmpty {
                print("  summary  : \(parsed.summary)")
            }
            if let outPath = output {
                try parsed.rawJSON.write(toFile: outPath, atomically: true, encoding: .utf8)
                print("  json     : \(outPath)")
            }
            if scoreCheck && !parsed.passes(threshold: threshold) {
                throw ExitCode.failure
            }
        }
    }
}
