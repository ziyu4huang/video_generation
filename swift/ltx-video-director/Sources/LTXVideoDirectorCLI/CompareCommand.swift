//
//  CompareCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video compare` — Swift parity with `run.py video compare`: generate
//  (or reuse) a reference image, auto-caption it into a video prompt, run a
//  matrix of LTX pipeline variants sequentially, then launch a side-by-side
//  review. No new engine — same orchestration Python's own video-compare.py
//  does (it shells to run.py itself for each step via subprocess); this
//  version shells to run.py the exact same way via RunPyBridge, then reuses
//  this package's own native `Review.launchReview` instead of re-shelling
//  for the review step.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct Compare: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "compare",
            abstract: "Pipeline A/B comparison: generate/caption a reference image, run a matrix of LTX pipeline variants, then review side-by-side."
        )

        struct PipelineConfig {
            let flags: [String]
            let cfgScale: Double
            let stgScale: Double
            let stage1StepsOverride: Int?
            let stage2StepsOverride: Int?
            let useImage: Bool
            let label: String
            let description: String
        }

        static let pipelineMatrix: [(name: String, config: PipelineConfig)] = [
            ("i2v", PipelineConfig(flags: [], cfgScale: 5.0, stgScale: 1.0, stage1StepsOverride: nil, stage2StepsOverride: nil, useImage: true, label: "I2V", description: "Standard I2V — dev + CFG + spatial 2x")),
            ("distilled-i2v", PipelineConfig(flags: ["--distilled"], cfgScale: 1.0, stgScale: 0.0, stage1StepsOverride: 8, stage2StepsOverride: 3, useImage: true, label: "Distilled-I2V", description: "Distilled I2V — fast, 8+3 steps, no CFG")),
            ("hq-i2v", PipelineConfig(flags: ["--hq"], cfgScale: 5.0, stgScale: 1.0, stage1StepsOverride: 20, stage2StepsOverride: nil, useImage: true, label: "HQ-I2V", description: "HQ I2V — res_2s + CFG=5, 20 steps (best quality)")),
            ("t2v", PipelineConfig(flags: [], cfgScale: 5.0, stgScale: 1.0, stage1StepsOverride: nil, stage2StepsOverride: nil, useImage: false, label: "T2V", description: "Standard T2V — text only, no reference image")),
            ("distilled-t2v", PipelineConfig(flags: ["--distilled"], cfgScale: 1.0, stgScale: 0.0, stage1StepsOverride: 8, stage2StepsOverride: 3, useImage: false, label: "Distilled-T2V", description: "Distilled T2V — fast, 8+3 steps, no CFG")),
            ("hq-t2v", PipelineConfig(flags: ["--hq"], cfgScale: 5.0, stgScale: 1.0, stage1StepsOverride: 20, stage2StepsOverride: nil, useImage: false, label: "HQ-T2V", description: "HQ T2V — res_2s + CFG=5, 20 steps, text only")),
            ("dasiwa-i2v", PipelineConfig(flags: ["--transformer", "dasiwa", "--hq"], cfgScale: 5.0, stgScale: 1.5, stage1StepsOverride: 20, stage2StepsOverride: 5, useImage: true, label: "DaSiWa-I2V", description: "DaSiWa Golden Lace v3 I2V — HQ + CFG=5 + STG=1.5, 20+5 steps")),
            ("dasiwa-t2v", PipelineConfig(flags: ["--transformer", "dasiwa", "--hq"], cfgScale: 5.0, stgScale: 1.5, stage1StepsOverride: 20, stage2StepsOverride: 5, useImage: false, label: "DaSiWa-T2V", description: "DaSiWa Golden Lace v3 T2V — HQ + CFG=5 + STG=1.5, 20+5 steps")),
        ]
        static let defaultPipelines = "i2v,distilled-i2v,hq-i2v"

        @Option(help: "Text prompt for the video (auto-captioned from the reference image if omitted).")
        var prompt: String?

        @Option(help: "Reference image for I2V pipelines. If omitted, Z-Image generates one.")
        var sourceImage: String?

        @Option(help: "Prompt for Z-Image generation (default: uses --prompt or a generic portrait).")
        var imagePrompt: String?

        @Option(help: "Z-Image output width.")
        var imageWidth: Int = 640

        @Option(help: "Z-Image output height.")
        var imageHeight: Int = 960

        @Option(help: "Z-Image denoising steps (default: pipeline default).")
        var imageSteps: Int?

        @Flag(help: "Skip auto-captioning; use --prompt as-is.")
        var skipCaption = false

        @Option(help: "Caption style for auto-captioning (default: 'prompt').")
        var captionStyle: String?

        @Option(help: "Comma-separated pipeline names (default: \(defaultPipelines)). Run --list-pipelines to see all options.")
        var pipelines: String = defaultPipelines

        @Flag(help: "List available pipeline names and exit.")
        var listPipelines = false

        @Flag(help: "Print the comparison plan without generating anything.")
        var dryRun = false

        @Option(help: "Frame count for each generated video.")
        var frames: Int = 49

        @Option(help: "Random seed.")
        var seed: Int = 42

        @Option(help: "Video width.")
        var width: Int = 704

        @Option(help: "Video height.")
        var height: Int = 448

        @Option(help: "Stage-1 step count (per-pipeline overrides still take precedence).")
        var stage1Steps: Int = 8

        @Option(help: "Stage-2 step count (per-pipeline overrides still take precedence).")
        var stage2Steps: Int?

        @Option(help: "Comma-separated review labels (default: derived from pipeline labels).")
        var labels: String?

        @Flag(help: "Write the review .js file but do not launch it.")
        var noOpen = false

        func run() throws {
            if listPipelines {
                Self.printPipelines()
                return
            }

            let selected = try Self.parsePipelines(pipelines)
            Self.printPlan(selected: selected, prompt: prompt, sourceImage: sourceImage, frames: frames, width: width, height: height, stage1Steps: stage1Steps, stage2Steps: stage2Steps)

            if dryRun {
                print("\n[compare] Dry run — no generation performed.")
                return
            }

            let imagePath = try getOrGenerateImage(selected: selected)
            let videoPrompt = try getOrCaptionPrompt(imagePath: imagePath)

            var manifestPaths: [String] = []
            var pipelineLabels: [String] = []
            let total = selected.count
            for (i, entry) in selected.enumerated() {
                if let manifest = try runPipelineSubprocess(name: entry.name, config: entry.config, prompt: videoPrompt, imagePath: imagePath, step: i + 1, total: total) {
                    manifestPaths.append(manifest)
                    pipelineLabels.append(entry.config.label)
                } else {
                    FileHandle.standardError.write("[compare] SKIPPED: \(entry.name) (generation failed)\n".data(using: .utf8)!)
                }
            }

            guard !manifestPaths.isEmpty else {
                throw ValidationError("no videos generated — nothing to review")
            }

            print("\n[compare] All done — launching review for \(manifestPaths.count) videos")
            let labelStr = labels ?? pipelineLabels.joined(separator: ",")
            try Review.launchReview(manifestPaths: manifestPaths, labels: labelStr, output: RepoPaths.defaultOutputDir.path, noOpen: noOpen)
        }

        // MARK: - Helpers

        static func printPipelines() {
            print("\nAvailable pipeline names for --pipelines:\n")
            for (name, config) in pipelineMatrix {
                let imgTag = config.useImage ? " [I2V]" : " [T2V]"
                print("  \(name.padding(toLength: 20, withPad: " ", startingAt: 0))\(imgTag)  —  \(config.description)")
            }
            print("\nDefault: \(defaultPipelines)\n")
        }

        static func parsePipelines(_ pipelinesStr: String) throws -> [(name: String, config: PipelineConfig)] {
            let names = pipelinesStr.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            var result: [(name: String, config: PipelineConfig)] = []
            for name in names {
                guard let entry = pipelineMatrix.first(where: { $0.name == name }) else {
                    throw ValidationError("unknown pipeline '\(name)'. Valid: \(pipelineMatrix.map(\.name).joined(separator: ", "))")
                }
                result.append(entry)
            }
            guard !result.isEmpty else {
                throw ValidationError("--pipelines is empty")
            }
            return result
        }

        static func printPlan(selected: [(name: String, config: PipelineConfig)], prompt: String?, sourceImage: String?, frames: Int, width: Int, height: Int, stage1Steps: Int, stage2Steps: Int?) {
            print("\n[compare] Pipeline comparison plan:")
            let needsImg = selected.contains { $0.config.useImage }
            if let sourceImage {
                print("  Source image:  \(sourceImage)")
            } else if needsImg {
                print("  Source image:  (generate with Z-Image)")
            }
            if let prompt {
                print("  Video prompt:  \(String(prompt.prefix(80)))")
            } else {
                print("  Video prompt:  (auto-caption from source image)")
            }
            print("  Frames:        \(frames)")
            print("  Resolution:    \(width)x\(height)")
            print("\n  Pipelines (\(selected.count)):")
            for (_, config) in selected {
                let s1 = config.stage1StepsOverride ?? stage1Steps
                let s2 = config.stage2StepsOverride ?? stage2Steps
                var stepsStr = "stage1=\(s1)"
                if let s2 { stepsStr += "+stage2=\(s2)" }
                let imgTag = (config.useImage && (sourceImage != nil || needsImg)) ? " + image" : ""
                print("    [\(config.label)] \(config.description)\(imgTag)  (\(stepsStr), cfg=\(config.cfgScale))")
            }
            print()
        }

        private func getOrGenerateImage(selected: [(name: String, config: PipelineConfig)]) throws -> String? {
            if let sourceImage {
                guard FileManager.default.fileExists(atPath: sourceImage) else {
                    throw ValidationError("--source-image not found: \(sourceImage)")
                }
                return URL(fileURLWithPath: sourceImage).standardizedFileURL.path
            }

            guard selected.contains(where: { $0.config.useImage }) else { return nil }

            let imgPrompt = imagePrompt ?? prompt ?? "cinematic portrait, photorealistic, detailed face"
            print("[compare] Step 1/4: Generating reference image with Z-Image")
            print("[compare] Image prompt: \(String(imgPrompt.prefix(100)))")

            let outputDir = RepoPaths.defaultOutputDir
            try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
            let before = Self.globPNGs(in: outputDir)

            var args = ["image", "t2i", "--prompt", imgPrompt, "--pipeline", "zimage",
                        "--seed", String(seed), "--width", String(imageWidth), "--height", String(imageHeight)]
            if let imageSteps { args += ["--steps", String(imageSteps)] }

            do {
                _ = try RunPyBridge.run(args)
            } catch {
                FileHandle.standardError.write("[compare] WARNING: Z-Image generation failed — I2V pipelines will be skipped\n".data(using: .utf8)!)
                return nil
            }

            let after = Self.globPNGs(in: outputDir)
            let newPNGs = after.subtracting(before).sorted { lhs, rhs in
                let l = (try? FileManager.default.attributesOfItem(atPath: lhs)[.modificationDate] as? Date) ?? Date.distantPast
                let r = (try? FileManager.default.attributesOfItem(atPath: rhs)[.modificationDate] as? Date) ?? Date.distantPast
                return l < r
            }
            guard let last = newPNGs.last else {
                FileHandle.standardError.write("[compare] WARNING: no PNG found after Z-Image generation\n".data(using: .utf8)!)
                return nil
            }
            print("[compare] Generated: \(URL(fileURLWithPath: last).lastPathComponent)")
            return last
        }

        private func getOrCaptionPrompt(imagePath: String?) throws -> String {
            if let prompt { return prompt }

            guard let imagePath else {
                return "A cinematic scene with smooth natural motion"
            }

            print("[compare] Step 2/4: Auto-captioning reference image")
            let captionPath = (imagePath as NSString).deletingPathExtension + ".caption.json"
            let style = captionStyle ?? "prompt"
            do {
                _ = try RunPyBridge.run(["caption", imagePath, "--style", style, "--lang", "en"])
                if let data = FileManager.default.contents(atPath: captionPath),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let caption = (obj["caption"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !caption.isEmpty {
                    print("[compare] Video prompt: \(String(caption.prefix(100)))...")
                    return caption
                }
            } catch {
                // fall through to the warning below
            }
            FileHandle.standardError.write("[compare] WARNING: caption failed — using generic prompt\n".data(using: .utf8)!)
            return "A cinematic scene with smooth natural motion"
        }

        private func runPipelineSubprocess(name: String, config: PipelineConfig, prompt: String, imagePath: String?, step: Int, total: Int) throws -> String? {
            let stage1 = config.stage1StepsOverride ?? stage1Steps
            let stage2 = config.stage2StepsOverride ?? stage2Steps
            let needsImage = config.useImage && imagePath != nil

            print("\n[compare] Pipeline \(step)/\(total) [\(config.label)]: \(config.description)")

            let outputDir = RepoPaths.defaultOutputDir
            let before = Self.globManifests(in: outputDir)

            var args = ["video", "generate",
                        "--prompt", prompt,
                        "--frames", String(frames),
                        "--stage1-steps", String(stage1),
                        "--seed", String(seed),
                        "--width", String(width),
                        "--height", String(height),
                        "--cfg-scale", String(config.cfgScale),
                        "--stg-scale", String(config.stgScale),
                        "--first-frame", "--caption", "--yes"] + config.flags
            if let stage2 { args += ["--stage2-steps", String(stage2)] }
            if needsImage, let imagePath { args += ["--input-image", imagePath] }

            let succeeded: Bool
            do {
                _ = try RunPyBridge.run(args)
                succeeded = true
            } catch {
                succeeded = false
            }

            let after = Self.globManifests(in: outputDir)
            let newManifests = after.subtracting(before).sorted { lhs, rhs in
                let l = (try? FileManager.default.attributesOfItem(atPath: lhs)[.modificationDate] as? Date) ?? Date.distantPast
                let r = (try? FileManager.default.attributesOfItem(atPath: rhs)[.modificationDate] as? Date) ?? Date.distantPast
                return l < r
            }

            guard succeeded, let manifest = newManifests.last else {
                FileHandle.standardError.write("[compare] [\(config.label)] FAILED\n".data(using: .utf8)!)
                return nil
            }
            print("[compare] [\(config.label)] OK — \(URL(fileURLWithPath: manifest).lastPathComponent)")
            return manifest
        }

        private static func globPNGs(in dir: URL) -> Set<String> {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
            return Set(entries.filter { $0.hasPrefix("output_") && $0.hasSuffix(".png") }.map { dir.appendingPathComponent($0).path })
        }

        private static func globManifests(in dir: URL) -> Set<String> {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
            return Set(entries.filter { $0.hasSuffix(".manifest.json") }.map { dir.appendingPathComponent($0).path })
        }
    }
}
