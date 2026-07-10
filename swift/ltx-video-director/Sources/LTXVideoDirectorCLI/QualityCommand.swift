//
//  QualityCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video quality` — Swift parity with `run.py video quality`'s
//  "analyze" mode (no-reference spatial + temporal metrics on existing
//  video files). Ported: VideoQuality.swift (7 spatial metrics matching
//  app/quality_metrics.py's analyze_frame + 3 temporal metrics matching
//  video-quality.py's analyze_video), --quality-inputs (video or
//  manifest.json), --quality-labels, --quality-json, --sample-every.
//
//  NOT ported in this pass (tracked as follow-up, not silently dropped):
//  the four --self-test modes (default/steps-sweep/degradation/restore-loop
//  — each drives its own generation/degradation pipeline, a separate scope
//  from the metrics themselves) and the HTML report + --vlm-score (the
//  static HTML/JS report generator and VLM scoring path are UI/UX
//  conveniences on top of these same JSON numbers, not new metrics).
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct Quality: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "quality",
            abstract: "No-reference video quality analysis (sharpness, noise, artifacts, temporal flicker/consistency)."
        )

        @Option(name: .customLong("quality-inputs"), parsing: .upToNextOption, help: "Video file(s) or manifest.json(s) to analyze.")
        var inputs: [String]

        @Option(help: "Sample every Nth frame for faster analysis (default: 1 = all).")
        var sampleEvery: Int = 1

        @Option(help: "Comma-separated labels for A/B comparison, e.g. 'Baseline,LoRA'.")
        var qualityLabels: String?

        @Option(help: "Save JSON report to this path.")
        var qualityJson: String?

        func run() throws {
            guard !inputs.isEmpty else {
                throw ValidationError("provide --quality-inputs (e.g. --quality-inputs output/video.mp4)")
            }

            var resolved: [String] = []
            for p in inputs {
                if p.hasSuffix(".manifest.json") {
                    guard let mp4 = Self.resolveManifestToMP4(p) else {
                        FileHandle.standardError.write("WARNING: could not find video for \(p), skipping\n".data(using: .utf8)!)
                        continue
                    }
                    resolved.append(mp4)
                } else {
                    guard FileManager.default.fileExists(atPath: p) else {
                        throw ValidationError("file not found: \(p)")
                    }
                    resolved.append(p)
                }
            }
            guard !resolved.isEmpty else {
                throw ValidationError("no videos to analyze")
            }

            var results: [VideoQualityReport] = []
            for vp in resolved {
                print("\n[quality] Analyzing: \(URL(fileURLWithPath: vp).lastPathComponent)")
                let report = try VideoQuality.analyze(videoURL: URL(fileURLWithPath: vp), sampleEvery: sampleEvery) { analyzed in
                    print("\r[quality]   Progress: \(analyzed) frames analyzed", terminator: "")
                    fflush(stdout)
                }
                print("\r[quality]   Done: \(report.framesAnalyzed) frames analyzed          ")
                results.append(report)
                Self.printSingleReport(report)
            }

            let labels = Self.makeLabels(qualityLabels, results.count)
            for i in results.indices { results[i].label = labels[i] }

            if results.count > 1 {
                Self.printComparison(results)
            }

            if let qualityJson {
                struct ReportData: Encodable { let mode: String; let videos: [VideoQualityReport] }
                let payload = ReportData(mode: results.count > 1 ? "compare" : "single", videos: results)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                let data = try encoder.encode(payload)
                try data.write(to: URL(fileURLWithPath: qualityJson))
                print("\n[quality] JSON report: \(qualityJson)")
            }
        }

        private static func resolveManifestToMP4(_ manifestPath: String) -> String? {
            guard let data = FileManager.default.contents(atPath: manifestPath),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            if let outputFiles = obj["output_files"] as? [[String: Any]] {
                for of in outputFiles {
                    if let p = of["path"] as? String, p.hasSuffix(".mp4"), FileManager.default.fileExists(atPath: p) {
                        return p
                    }
                }
            }
            let base = manifestPath.replacingOccurrences(of: ".manifest.json", with: "")
            let mp4 = base + ".mp4"
            return FileManager.default.fileExists(atPath: mp4) ? mp4 : nil
        }

        private static func makeLabels(_ labelsArg: String?, _ n: Int) -> [String] {
            if let labelsArg {
                let parts = labelsArg.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                if parts.count >= n { return Array(parts.prefix(n)) }
            }
            return (0..<n).map { String(UnicodeScalar(65 + $0)!) }
        }

        private static func printSingleReport(_ report: VideoQualityReport) {
            let pf = report.perFrame
            let tp = report.temporal
            print("  Per-frame averages:")
            print("    Sharpness (Laplacian σ²)  : \(fmt(pf["sharpness"]?.mean, 1))  ↑ better")
            print("    Edge density (Sobel)      : \(fmt(pf["edge_density"]?.mean, 2))  ↑ better")
            print("    Contrast (luminance σ)    : \(fmt(pf["contrast"]?.mean, 2))  ↑ better")
            print("    Noise (MAD σ)             : \(fmt(pf["noise_sigma"]?.mean, 2))  ↓ better")
            print("    SNR (dB)                  : \(fmt(pf["snr_db"]?.mean, 1))  ↑ better")
            print("    Blockiness (8×8)          : \(fmt(pf["blockiness"]?.mean, 1))  ↓ better")
            print("    Color saturation σ        : \(fmt(pf["saturation_std"]?.mean, 1))  —")
            print("  Temporal:")
            print("    Flicker (mean)            : \(fmt(tp.flickerMean, 1))  ↓ better")
            print("    Flicker (max)             : \(fmt(tp.flickerMax, 1))  ↓ better")
            print("    Frame consistency (NCC)   : \(fmt(tp.consistencyNCC, 3))  ↑ better")
        }

        private static func printComparison(_ results: [VideoQualityReport]) {
            print("\n[quality] Comparison:")
            let header = (["Metric"] + results.map { $0.label ?? "?" }).joined(separator: "  |  ")
            print("  \(header)")
            let keys: [(String, String)] = [
                ("sharpness", "Sharpness"), ("edge_density", "Edge density"), ("contrast", "Contrast"),
                ("noise_sigma", "Noise σ"), ("snr_db", "SNR (dB)"), ("blockiness", "Blockiness"),
                ("saturation_std", "Saturation σ"),
            ]
            for (key, label) in keys {
                let vals = results.map { fmt($0.perFrame[key]?.mean, 2) }
                print("  \(([label] + vals).joined(separator: "  |  "))")
            }
            let flickerRow = (["Flicker mean"] + results.map { fmt($0.temporal.flickerMean, 2) }).joined(separator: "  |  ")
            let consistencyRow = (["Consistency NCC"] + results.map { fmt($0.temporal.consistencyNCC, 3) }).joined(separator: "  |  ")
            print("  \(flickerRow)")
            print("  \(consistencyRow)")
        }

        private static func fmt(_ v: Double?, _ digits: Int) -> String {
            guard let v else { return "n/a" }
            return String(format: "%.\(digits)f", v)
        }
    }
}
