//
//  ImageGenUtilsCLI.swift
//  ImageGenUtilsCLI
//
//  `image-gen-utils` — standalone CLI for the LM-Studio VLM integration.
//  Mirrors `run.py caption` so any director (or shell script) can caption /
//  score an image without spawning the full image-gen pipeline.
//

import ArgumentParser
import Foundation
import ImageGenUtils

@main
struct ImageGenUtilsCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "image-gen-utils",
        abstract: "Shared LM-Studio VLM utilities (caption / score / review) + upscaler.",
        version: "0.1.0",
        subcommands: [Caption.self, Score.self, Review.self, Styles.self, Upscale.self, Metrics.self]
    )
}

extension ImageGenUtilsCLI {
    struct Caption: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "caption",
            abstract: "Caption an image via local Qwen3-VL (LM Studio)."
        )

        @Argument(help: "Path to the image to caption.")
        var image: String

        @Option(help: "Style: default|photography|t2i|score|review, or a literal prompt.")
        var style: String = "default"

        @Option(help: "LM Studio API URL (default: $LMSTUDIO_API_URL or http://localhost:1234/v1).")
        var apiUrl: String = CaptionClient.defaultAPIURL

        @Option(help: "VLM model id (default: $LMSTUDIO_MODEL or qwen/qwen3-vl-4b).")
        var model: String = CaptionClient.defaultModel

        @Option(help: "Max output tokens.")
        var maxTokens: Int = 2048

        @Option(help: "Output path for the raw caption text (default: stdout).")
        var output: String?

        func run() throws {
            let imageURL = URL(fileURLWithPath: image)
            guard FileManager.default.fileExists(atPath: imageURL.path) else {
                throw ValidationError("Image not found: \(image)")
            }
            print("caption: \(URL(fileURLWithPath: image).lastPathComponent) [style=\(style), model=\(model)]")
            let raw = try CaptionClient.caption(
                imageURL: imageURL, style: style,
                apiURL: apiUrl, model: model, maxTokens: maxTokens
            )
            print("")
            print(raw)
            if let outputPath = output {
                try raw.write(toFile: outputPath, atomically: true, encoding: .utf8)
                print("\n(saved to \(outputPath))")
            }
        }
    }
}

extension ImageGenUtilsCLI {
    struct Score: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "score",
            abstract: "Score an image's quality via VLM; print parsed JSON + pass/fail."
        )

        @Argument(help: "Path to the image to score.")
        var image: String

        @Option(help: "LM Studio API URL (default: $LMSTUDIO_API_URL or http://localhost:1234/v1).")
        var apiUrl: String = CaptionClient.defaultAPIURL

        @Option(help: "VLM model id (default: $LMSTUDIO_MODEL or qwen/qwen3-vl-4b).")
        var model: String = CaptionClient.defaultModel

        @Option(help: "Pass threshold: overall AND artifacts must both >= this (default 7).")
        var threshold: Int = 7

        @Flag(help: "Exit non-zero when the image fails the threshold (for scripting / CI).")
        var check: Bool = false

        @Option(help: "Output path for the raw JSON payload (default: stdout only).")
        var output: String?

        func run() throws {
            let imageURL = URL(fileURLWithPath: image)
            guard FileManager.default.fileExists(atPath: imageURL.path) else {
                throw ValidationError("Image not found: \(image)")
            }
            print("score: \(URL(fileURLWithPath: image).lastPathComponent) [model=\(model)]")
            let parsed = try CaptionClient.score(
                imageURL: imageURL, apiURL: apiUrl, model: model
            )
            guard let parsed else {
                print("⚠️ could not parse JSON score from VLM response.")
                throw ExitCode.failure
            }
            let verdict = parsed.passes(threshold: threshold) ? "PASS ✅" : "FAIL ❌"
            print("overall=\(parsed.overall) detail=\(parsed.detail) " +
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
            if let outputPath = output {
                try parsed.rawJSON.write(toFile: outputPath, atomically: true, encoding: .utf8)
                print("  json     : \(outputPath)")
            }
            if check && !parsed.passes(threshold: threshold) {
                throw ExitCode.failure
            }
        }
    }
}

extension ImageGenUtilsCLI {
    struct Review: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "review",
            abstract: "Review a T2I output against its original prompt (element check + score)."
        )

        @Argument(help: "Path to the image to review.")
        var image: String

        @Option(help: "Original T2I prompt (required — checked for element adherence).")
        var prompt: String

        @Option(help: "LM Studio API URL (default: $LMSTUDIO_API_URL or http://localhost:1234/v1).")
        var apiUrl: String = CaptionClient.defaultAPIURL

        @Option(help: "VLM model id (default: $LMSTUDIO_MODEL or qwen/qwen3-vl-4b).")
        var model: String = CaptionClient.defaultModel

        @Option(help: "Output path for the raw JSON payload (default: stdout only).")
        var output: String?

        func run() throws {
            let imageURL = URL(fileURLWithPath: image)
            guard FileManager.default.fileExists(atPath: imageURL.path) else {
                throw ValidationError("Image not found: \(image)")
            }
            print("review: \(URL(fileURLWithPath: image).lastPathComponent) [model=\(model)]")
            let parsed = try CaptionClient.score(
                imageURL: imageURL, style: "review", prompt: prompt,
                apiURL: apiUrl, model: model
            )
            guard let parsed else {
                print("⚠️ could not parse JSON review from VLM response.")
                throw ExitCode.failure
            }
            print("overall=\(parsed.overall) detail=\(parsed.detail) " +
                  "sharp=\(parsed.sharpness) comp=\(parsed.composition) " +
                  "adhere=\(parsed.promptAdherence) artifacts=\(parsed.artifacts)")
            if !parsed.issues.isEmpty {
                print("  issues   : \(parsed.issues.joined(separator: "; "))")
            }
            if !parsed.summary.isEmpty {
                print("  summary  : \(parsed.summary)")
            }
            if let outputPath = output {
                try parsed.rawJSON.write(toFile: outputPath, atomically: true, encoding: .utf8)
                print("  json     : \(outputPath)")
            }
        }
    }
}

extension ImageGenUtilsCLI {
    struct Upscale: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "upscale",
            abstract: "Upscale an image via CoreImage Lanczos (no model weights, instant)."
        )

        @Argument(help: "Path to the input image.")
        var image: String

        @Option(help: "Scale factor (e.g. 2, 3, 4). Mutually exclusive with --longest-edge.")
        var factor: Double?

        @Option(help: "Target longest edge in px (e.g. 2160). Mutually exclusive with --factor.")
        var longestEdge: Int?

        @Option(help: "Output PNG path (default: <input>_<factor>x.png).")
        var output: String?

        func run() throws {
            let inputURL = URL(fileURLWithPath: image)
            guard FileManager.default.fileExists(atPath: inputURL.path) else {
                throw ValidationError("Image not found: \(image)")
            }
            guard factor != nil || longestEdge != nil else {
                throw ValidationError("Specify either --factor or --longest-edge.")
            }
            guard !(factor != nil && longestEdge != nil) else {
                throw ValidationError("--factor and --longest-edge are mutually exclusive.")
            }
            let outputPath = output.map(URL.init(fileURLWithPath:))
            let dest: URL
            if let factor {
                dest = try Upscaler.scale(input: inputURL, factor: factor, output: outputPath)
            } else {
                dest = try Upscaler.scaleToLongestEdge(
                    input: inputURL, longestEdge: longestEdge!, output: outputPath
                )
            }
            print("Upscaled → \(dest.path)")
        }
    }
}

extension ImageGenUtilsCLI {
    struct Styles: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "styles",
            abstract: "List available caption styles."
        )

        func run() throws {
            print("Caption styles:")
            for style in CaptionStyle.allCases {
                print("  - \(style.rawValue)")
            }
            print("\nUnknown style strings are treated as literal free-form prompts.")
        }
    }
}
