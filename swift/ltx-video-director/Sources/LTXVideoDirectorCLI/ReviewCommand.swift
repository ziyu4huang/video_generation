//
//  ReviewCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video review` — Swift parity with `run.py video review --inputs ...`
//  (the "review existing manifests" path only; the Python `video review
//  generate ...` path re-runs run.py's own generation pipeline first, which
//  is out of scope here — this reads whatever manifest.json/run.json pairs
//  already exist on disk, regardless of which pipeline produced them).
//
//  No new engine: this is JSON reading + JS templating, reusing the exact
//  same static viewer template Python renders
//  (python/mlx-movie-director/scripts/review-viewer-static.js) so the
//  generated .js file is byte-for-byte the same viewer either CLI produces.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct Review: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "review",
            abstract: "Generate a self-contained Bun video reviewer for A/B test sessions from existing manifest.json files."
        )

        @Option(parsing: .upToNextOption, help: "One or more manifest.json paths (for reviewing existing results).")
        var inputs: [String]

        @Option(help: "Comma-separated labels, e.g. 'A,B,C,D' (auto A/B/C/D… if omitted).")
        var labels: String?

        @Option(name: .shortAndLong, help: "Output directory (default: same dir as first input).")
        var output: String?

        @Flag(help: "Write the .js file but do not launch it.")
        var noOpen = false

        func run() throws {
            guard !inputs.isEmpty else {
                throw ValidationError("--inputs required for 'review' (e.g. --inputs output/*.manifest.json)")
            }
            try Self.launchReview(manifestPaths: inputs, labels: labels, output: output, noOpen: noOpen)
        }

        // MARK: - Shared review launch logic (mirrors video-review.py's _launch_review)

        static func launchReview(manifestPaths rawPaths: [String], labels labelsArg: String?, output: String?, noOpen: Bool) throws {
            let manifestPaths = rawPaths.map { $0.hasSuffix(".manifest.json") ? $0 : $0 + ".manifest.json" }
            let tests = manifestPaths.map(loadTest)

            var validTests: [[String: Any]] = []
            for t in tests {
                if (t["status"] as? String) == "error" {
                    let err = (t["error_message"] as? String) ?? "unknown error"
                    FileHandle.standardError.write("  WARNING: skipping failed test: \(err)\n".data(using: .utf8)!)
                } else {
                    validTests.append(t)
                }
            }
            guard !validTests.isEmpty else {
                throw ValidationError("no successful tests to review")
            }
            if validTests.count < tests.count {
                print("[video-review] \(validTests.count)/\(tests.count) tests succeeded, reviewing successful ones")
            }

            let resolvedLabels = makeLabels(labelsArg, validTests.count)
            var labeledTests = validTests
            for i in labeledTests.indices { labeledTests[i]["label"] = resolvedLabels[i] }

            let model = detectModel(labeledTests)
            let firstManifestURL = URL(fileURLWithPath: manifestPaths[0]).standardizedFileURL
            let outDir = output ?? firstManifestURL.deletingLastPathComponent().path
            try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

            let slug = model.replacingOccurrences(of: " ", with: "-").replacingOccurrences(of: "/", with: "-").lowercased()
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyyMMdd_HHmmss"
            let ts = formatter.string(from: Date())
            let outJS = URL(fileURLWithPath: outDir).appendingPathComponent("video-reviewer-\(slug)-\(ts).js")

            let configJS = try renderConfigJS(tests: labeledTests, model: model, outJS: outJS)
            let staticJS = try readStaticTemplate()
            let fullJS = configJS + "\n\n" + staticJS
            try fullJS.write(to: outJS, atomically: true, encoding: .utf8)

            let totalBytes = labeledTests.compactMap { $0["video_file"] as? String }
                .compactMap { try? FileManager.default.attributesOfItem(atPath: $0)[.size] as? Int }
                .reduce(0, +)
            let totalMB = Double(totalBytes) / 1_048_576
            let nThumb = labeledTests.filter { ($0["thumbnail_file"] as? String) != nil }.count
            let nCap = labeledTests.filter { ($0["caption_text"] as? String)?.isEmpty == false }.count
            print("[video-review] Written: \(outJS.path)")
            var summary = "[video-review] Tests:   \(labeledTests.count)  (\(String(format: "%.1f", totalMB)) MB video on disk"
            if nThumb > 0 { summary += ", \(nThumb) thumbnails" }
            if nCap > 0 { summary += ", \(nCap) captions" }
            summary += ")"
            print(summary)

            if !noOpen {
                startServer(outJS: outJS)
            }
        }

        private static func startServer(outJS: URL) {
            guard let bun = which("bun") else {
                print("ERROR: bun not found. Install from https://bun.sh, then run:")
                print("  bun run \(outJS.path)")
                return
            }
            let logURL = FileManager.default.temporaryDirectory.appendingPathComponent("video-review-\(UUID().uuidString).log")
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
            guard let logHandle = FileHandle(forWritingAtPath: logURL.path) else { return }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: bun)
            process.arguments = ["run", outJS.path]
            process.standardOutput = logHandle
            process.standardError = logHandle
            do {
                try process.run()
            } catch {
                print("[video-review] failed to launch bun: \(error)")
                return
            }
            logHandle.closeFile()

            var url: String? = nil
            for _ in 0..<50 {
                Thread.sleep(forTimeInterval: 0.1)
                if let content = try? String(contentsOf: logURL, encoding: .utf8) {
                    for line in content.split(separator: "\n") where line.contains("Serving at") {
                        url = line.split(separator: " ").last.map(String.init)
                        break
                    }
                }
                if url != nil { break }
            }
            if let url {
                let open = Process()
                open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                open.arguments = [url]
                try? open.run()
                print("[video-review] Opened \(url)")
                print("[video-review] Log: \(logURL.path)  (PID: \(process.processIdentifier))")
            } else {
                print("[video-review] Server started but could not detect URL")
                print("[video-review] Log: \(logURL.path)  (PID: \(process.processIdentifier))")
            }
        }

        private static func which(_ name: String) -> String? {
            for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
                let path = "\(dir)/\(name)"
                if FileManager.default.isExecutableFile(atPath: path) { return path }
            }
            if let pathEnv = ProcessInfo.processInfo.environment["PATH"] {
                for dir in pathEnv.split(separator: ":") {
                    let path = "\(dir)/\(name)"
                    if FileManager.default.isExecutableFile(atPath: path) { return path }
                }
            }
            return nil
        }

        // MARK: - Manifest loading (mirrors _load_test)

        private static func loadJSONDict(_ path: String) -> [String: Any] {
            guard let data = FileManager.default.contents(atPath: path),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return [:]
            }
            return obj
        }

        private static func loadTest(manifestPath: String) -> [String: Any] {
            let base = manifestPath.replacingOccurrences(of: ".manifest.json", with: "")
            let runPath = base + ".run.json"

            var manifest: [String: Any] = [:]
            if FileManager.default.fileExists(atPath: manifestPath) {
                manifest = loadJSONDict(manifestPath)
            } else {
                FileHandle.standardError.write("  WARNING: not found: \(manifestPath)\n".data(using: .utf8)!)
            }
            let run: [String: Any] = FileManager.default.fileExists(atPath: runPath) ? loadJSONDict(runPath) : [:]

            var videoFile: String? = nil
            if let outputFiles = manifest["output_files"] as? [[String: Any]] {
                for of in outputFiles {
                    guard let p = of["path"] as? String, p.hasSuffix(".mp4"), FileManager.default.fileExists(atPath: p) else { continue }
                    if (of["mode"] as? String) == "relay-final" {
                        videoFile = p
                        break
                    } else if videoFile == nil {
                        videoFile = p
                    }
                }
            }
            if videoFile == nil {
                let mp4 = base + ".mp4"
                if FileManager.default.fileExists(atPath: mp4) { videoFile = mp4 }
            }
            if let videoFile {
                let mb = (Double((try? FileManager.default.attributesOfItem(atPath: videoFile)[.size] as? Int) ?? 0) / 1_048_576)
                print("  Video      \(URL(fileURLWithPath: videoFile).lastPathComponent) (\(String(format: "%.1f", mb)) MB)")
            }

            var thumbnailPath: String? = nil
            let pngPath = base + ".png"
            if FileManager.default.fileExists(atPath: pngPath) {
                thumbnailPath = URL(fileURLWithPath: pngPath).standardizedFileURL.path
                print("  Thumbnail  \(URL(fileURLWithPath: pngPath).lastPathComponent)")
            }

            var captionText: String? = nil
            let captionPath = base + ".caption.json"
            if FileManager.default.fileExists(atPath: captionPath) {
                let capDict = loadJSONDict(captionPath)
                captionText = capDict["caption"] as? String ?? ""
                let preview = String((captionText ?? "").prefix(60)).replacingOccurrences(of: "\n", with: " ")
                print("  Caption    \(URL(fileURLWithPath: captionPath).lastPathComponent): \(preview)…")
            }

            var params: [String: Any] = [:]
            let keys = ["cfg_scale", "stg_scale", "steps", "stage1_steps", "stage2_steps",
                        "seed", "width", "height", "frames", "fps", "lora_scale",
                        "denoise_strength", "low_ram", "distilled", "hq",
                        "teacache", "teacache_thresh", "temporal_upscale"]
            for key in keys {
                guard let v = run[key] else { continue }
                if let b = v as? Bool, !b { continue }
                params[key] = v
            }
            if let teacache = params["teacache"] as? Bool, teacache, let thresh = params["teacache_thresh"] {
                params["teacache"] = "True (thresh=\(thresh))"
                params.removeValue(forKey: "teacache_thresh")
            } else if params["teacache_thresh"] != nil, !(params["teacache"] as? Bool ?? false) {
                params.removeValue(forKey: "teacache_thresh")
            }

            var modeStr: String? = nil
            if let outFiles = manifest["output_files"] as? [[String: Any]], let first = outFiles.first {
                modeStr = first["mode"] as? String
            }
            if modeStr == nil || modeStr!.isEmpty {
                modeStr = pipelineDisplayLabel(run["pipeline"] as? String ?? "")
            }
            if let modeStr, !modeStr.isEmpty {
                var withMode: [String: Any] = ["mode": modeStr]
                for (k, v) in params { withMode[k] = v }
                params = withMode
            }

            var errorMessage = ""
            if let errorInfo = manifest["error"] as? [String: Any] {
                let type = errorInfo["type"] as? String ?? "Error"
                let message = errorInfo["message"] as? String ?? ""
                errorMessage = "\(type): \(message)"
            }

            return [
                "video_file": videoFile as Any,
                "thumbnail_file": thumbnailPath as Any,
                "caption_text": captionText as Any,
                "status": manifest["status"] as? String ?? "unknown",
                "prompt": (run["prompt"] as? String) ?? (run["prompt_file"] as? String) ?? "",
                "params": params,
                "elapsed": manifest["elapsed_seconds"] as Any,
                "memory_mb": manifest["memory_peak_mb"] as Any,
                "models": manifest["models"] as? [String: Any] ?? [:],
                "error_message": errorMessage,
            ]
        }

        private static func makeLabels(_ labelsArg: String?, _ n: Int) -> [String] {
            if let labelsArg {
                let parts = labelsArg.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                if parts.count >= n { return Array(parts.prefix(n)) }
            }
            return (0..<n).map { String(UnicodeScalar(65 + $0)!) }
        }

        private static func detectModel(_ tests: [[String: Any]]) -> String {
            for t in tests {
                guard let models = t["models"] as? [String: Any] else { continue }
                for key in models.keys {
                    let lower = key.lowercased()
                    if lower.contains("ltx") { return "ltx-2.3" }
                    if lower.contains("flux") { return "flux2" }
                    if lower.contains("zimage") || lower.contains("moody") { return "zimage" }
                }
            }
            return "video"
        }

        private static func renderConfigJS(tests: [[String: Any]], model: String, outJS: URL) throws -> String {
            let iso = ISO8601DateFormatter()
            let now = iso.string(from: Date())
            let elapsedValues = tests.compactMap { $0["elapsed"] as? Double }
            let elapsedMax = elapsedValues.max()

            let testsData: [[String: Any]] = tests.map { t in
                let params = t["params"] as? [String: Any] ?? [:]
                return [
                    "label": t["label"] as? String ?? "",
                    "status": t["status"] as? String ?? "unknown",
                    "prompt": t["prompt"] as? String ?? "",
                    "params": params,
                    "pipelineLabel": pipelineDisplayLabel(params["pipeline"] as? String ?? ""),
                    "pipelineColor": pipelineColor(params["pipeline"] as? String ?? ""),
                    "elapsed": t["elapsed"] as Any,
                    "elapsedMax": elapsedMax as Any,
                    "memory_mb": t["memory_mb"] as Any,
                    "mime": "video/mp4",
                    "videoPath": t["video_file"] as? String ?? "",
                    "thumbnailPath": t["thumbnail_file"] as? String ?? "",
                    "caption": t["caption_text"] as? String ?? "",
                ]
            }
            let payload: [String: Any] = [
                "model": model, "generatedAt": now,
                "reviewerJsPath": outJS.standardizedFileURL.path, "tests": testsData,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            let configJSON = String(data: data, encoding: .utf8) ?? "{}"
            return """
            // AUTO-GENERATED — regenerate with: ltx-video review --inputs ...
            // Model: \(model)  |  Generated: \(now)
            const CONFIG = \(configJSON);
            """
        }

        private static func pipelineDisplayLabel(_ pipeline: String) -> String {
            let mapping = [
                "ltx-i2v": "I2V", "ltx-t2v": "T2V",
                "ltx-distilled": "Distilled-T2V", "ltx-distilled-i2v": "Distilled-I2V",
                "ltx-hq": "HQ-T2V", "ltx-hq-i2v": "HQ-I2V",
                "ltx-a2v": "A2V", "ltx-flf2v": "FLF2V",
                "ltx-one-stage": "One-Stage-T2V", "ltx-one-stage-i2v": "One-Stage-I2V",
            ]
            if let mapped = mapping[pipeline] { return mapped }
            guard !pipeline.isEmpty else { return "" }
            return pipeline.replacingOccurrences(of: "ltx-", with: "").uppercased()
        }

        private static func pipelineColor(_ pipeline: String) -> String {
            if pipeline.contains("distilled") { return "purple" }
            if pipeline.contains("hq") { return "gold" }
            if pipeline.contains("flf2v") { return "teal" }
            if pipeline.contains("a2v") { return "green" }
            if pipeline.contains("i2v") { return "blue" }
            if pipeline.contains("one-stage") { return "orange" }
            return "gray"
        }

        private static func readStaticTemplate() throws -> String {
            let templateURL = RepoPaths.root
                .appendingPathComponent("python/mlx-movie-director/scripts/review-viewer-static.js")
            guard FileManager.default.fileExists(atPath: templateURL.path) else {
                throw ValidationError("static template not found: \(templateURL.path)")
            }
            return try String(contentsOf: templateURL, encoding: .utf8)
        }
    }
}
